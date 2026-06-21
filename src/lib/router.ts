/**
 * Client for the ce-infer ROUTER — an OpenAI-compatible HTTP+SSE API, on the hospital
 * LAN behind the SSO reverse proxy. The browser never holds a raw API token: the proxy
 * authenticates the principal (OIDC/SAML) and injects the identity the router maps to a
 * per-principal CE capability. We send only the workload `op` and (optionally) a
 * caller-supplied `record_ref` (a SHA-256 of the source record — NEVER raw PHI) for the
 * audit trail. PHI in messages goes to the on-LAN router only; never to any third party.
 *
 * Endpoints (PLAN §7 / §09):
 *   POST /v1/chat/completions   (stream=true → SSE token deltas)
 *   GET  /v1/models             (live model truth, derived from registry × atlas)
 *   GET  /healthz               (lightweight live worker count)
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelInfo {
  id: string;
  /** OpenAI-style object kind; "model". */
  object: string;
  /** Owner/registry tag, e.g. "ce-infer". */
  ownedBy: string;
  /** Live worker count serving this model right now (router extension), if provided. */
  workers: number | null;
}

export interface HealthInfo {
  ok: boolean;
  /** Total live workers across the fleet the router can reach. */
  workers: number;
  /** Router build/version string, if surfaced. */
  version: string | null;
}

/** A single streamed chunk surfaced to the UI. */
export interface StreamChunk {
  /** Token delta text (may be empty on role/control frames). */
  delta: string;
  /** Worker provenance — the node id that served this response, if the router relays it. */
  worker: string | null;
  /** Resolved concrete model id (registry alias → concrete), if surfaced. */
  model: string | null;
  /** OpenAI finish reason on the terminal frame. */
  finishReason: string | null;
}

export interface CompletionOptions {
  model: string;
  op: "chat" | "summarize" | "code";
  messages: ChatMessage[];
  /** Caller-computed SHA-256 of the source record for audit (never PHI). Optional. */
  recordRef?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Raw OpenAI streaming chunk shape (the subset we read). */
interface RawStreamChunk {
  model?: string;
  // Router provenance extensions (non-standard, optional): top-level or per-choice.
  worker?: string;
  ce_worker?: string;
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
    ce_worker?: string;
  }>;
}

export class RouterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
  ) {}

  private url(path: string): string {
    const b = this.baseUrl.replace(/\/$/, "");
    return `${b}${path}`;
  }

  /** `GET /healthz` → live worker count. Best-effort; never throws to the caller. */
  async health(signal?: AbortSignal): Promise<HealthInfo> {
    try {
      const init: RequestInit = { method: "GET", credentials: "include" };
      if (signal) init.signal = signal;
      const r = await this.fetchImpl(this.url("/healthz"), init);
      if (!r.ok) return { ok: false, workers: 0, version: null };
      const body = (await r.json()) as {
        ok?: boolean;
        status?: string;
        workers?: number;
        workers_online?: number;
        version?: string;
      };
      const workers = body.workers ?? body.workers_online ?? 0;
      // Healthy unless the body explicitly says otherwise (ok:false or a non-"ok" status).
      const ok = body.ok ?? (body.status === undefined ? true : body.status === "ok");
      return { ok, workers, version: body.version ?? null };
    } catch {
      return { ok: false, workers: 0, version: null };
    }
  }

  /** `GET /v1/models` → published model ids (+ live worker counts when surfaced). */
  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    const init: RequestInit = { method: "GET", credentials: "include" };
    if (signal) init.signal = signal;
    const r = await this.fetchImpl(this.url("/v1/models"), init);
    if (!r.ok) throw new Error(`GET /v1/models → ${r.status}`);
    const body = (await r.json()) as {
      data?: Array<{
        id: string;
        object?: string;
        owned_by?: string;
        workers?: number;
        ce_workers?: number;
      }>;
    };
    return (body.data ?? []).map((m) => ({
      id: m.id,
      object: m.object ?? "model",
      ownedBy: m.owned_by ?? "ce-infer",
      workers: m.workers ?? m.ce_workers ?? null,
    }));
  }

  /**
   * `POST /v1/chat/completions` with `stream=true`. Yields token deltas as they arrive
   * over SSE. Worker provenance and the resolved model id are surfaced on whichever
   * chunk carries them (router-dependent); callers latch the last non-null value.
   */
  async *streamCompletion(opts: CompletionOptions): AsyncGenerator<StreamChunk> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      // Workload op → the router audits it and selects the infer:<op> ability.
      "X-CE-Op": opts.op,
    };
    // record_ref is a hash of the source record for the audit trail — NEVER raw PHI.
    if (opts.recordRef) headers["X-CE-Record-Ref"] = opts.recordRef;

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
    };
    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
    if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "include",
    };
    if (opts.signal) init.signal = opts.signal;

    const resp = await this.fetchImpl(this.url("/v1/chat/completions"), init);
    if (!resp.ok || !resp.body) {
      const text = await safeText(resp);
      throw new Error(`completion failed (${resp.status})${text ? `: ${text}` : ""}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Process complete frames only.
        let sep: number;
        while ((sep = indexOfFrameEnd(buf)) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep).replace(/^(\r?\n)+/, "");
          const chunk = parseFrame(frame);
          if (chunk === "DONE") return;
          if (chunk) yield chunk;
        }
      }
      // Flush any trailing partial frame.
      const tail = parseFrame(buf);
      if (tail && tail !== "DONE") yield tail;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
  }
}

/** Index of the end of the first complete SSE frame (after its blank-line separator). */
function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b === -1 ? -1 : b + 4;
  if (b === -1) return a + 2;
  return Math.min(a + 2, b + 4);
}

/** Parse one SSE frame's `data:` lines into a StreamChunk, "DONE", or null. */
function parseFrame(frame: string): StreamChunk | "DONE" | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return "DONE";

  let raw: RawStreamChunk;
  try {
    raw = JSON.parse(payload) as RawStreamChunk;
  } catch {
    return null;
  }

  const choice = raw.choices?.[0];
  const delta = choice?.delta?.content ?? "";
  const worker = raw.worker ?? raw.ce_worker ?? choice?.ce_worker ?? null;
  const finishReason = choice?.finish_reason ?? null;
  return { delta, worker, model: raw.model ?? null, finishReason };
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Compute a SHA-256 hex digest of a source record for the audit `record_ref`. This is a
 * one-way hash sent for tamper-evident provenance — it is NOT reversible and carries no
 * PHI. Returns null where SubtleCrypto is unavailable (e.g. non-secure context).
 */
export async function recordRefHash(source: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(source);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
