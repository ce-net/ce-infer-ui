/**
 * The reactive store driving the clinician chat surface.
 *
 * Owns:
 *  - the in-memory transcript (NEVER persisted; wiped on idle-logoff and tab close),
 *  - the active workload (chat/summarize/code),
 *  - a slow poll of the router's `/healthz` (live worker count) and `/v1/models`,
 *  - the streaming completion lifecycle (one in-flight stream at a time).
 *
 * It is a plain event emitter; the chat panels subscribe to `change` and re-render.
 */

import { RouterClient, recordRefHash, type ModelInfo, type ChatMessage } from "../lib/router.js";
import { WORKLOADS, type Op } from "../lib/workloads.js";
import { loadConfig } from "../lib/config.js";

export type Health = "online" | "connecting" | "offline";

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  /** Rendered text. For the streaming assistant turn this grows token by token. */
  text: string;
  /** Worker node id that served this answer (provenance), assistant turns only. */
  worker: string | null;
  /** Resolved concrete model id, assistant turns only. */
  model: string | null;
  /** Workload this turn was produced under. */
  op: Op;
  /** Whether this assistant turn is still streaming. */
  streaming: boolean;
  /** Set when the turn ended in an error. */
  error: string | null;
  ts: number;
}

export interface ChatState {
  health: Health;
  workers: number;
  routerVersion: string | null;
  models: ModelInfo[];
  op: Op;
  turns: TranscriptTurn[];
  /** True while a completion is streaming. */
  busy: boolean;
}

type Listener = () => void;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq.toString(36)}`;
}

export class ChatStore {
  state: ChatState;
  private router: RouterClient;
  private listeners = new Set<Listener>();
  private timers: number[] = [];
  private poll = new AbortController();
  /** Abort handle for the in-flight completion stream, if any. */
  private streamAbort: AbortController | null = null;

  constructor() {
    const cfg = loadConfig();
    this.router = new RouterClient(cfg.routerUrl);
    this.state = {
      health: "connecting",
      workers: 0,
      routerVersion: null,
      models: [],
      op: "chat",
      turns: [],
      busy: false,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  start(): void {
    this.stop();
    this.poll = new AbortController();
    void this.refreshHealth();
    void this.refreshModels();
    this.timers.push(window.setInterval(() => void this.refreshHealth(), 8_000));
    this.timers.push(window.setInterval(() => void this.refreshModels(), 30_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.poll.abort();
    this.cancelStream();
  }

  /** Wipe the transcript from memory (idle-logoff / new session). No persistence touched. */
  wipeTranscript(): void {
    this.cancelStream();
    this.set({ turns: [], busy: false });
  }

  setOp(op: Op): void {
    if (op === this.state.op) return;
    this.set({ op });
  }

  private async refreshHealth(): Promise<void> {
    const h = await this.router.health(this.poll.signal);
    this.set({
      health: h.ok ? "online" : "offline",
      workers: h.workers,
      routerVersion: h.version,
    });
  }

  private async refreshModels(): Promise<void> {
    try {
      const models = await this.router.models(this.poll.signal);
      this.set({ models });
    } catch {
      // models endpoint may be briefly unavailable; keep prior list
    }
  }

  /** Live worker count for the currently-selected workload's model, if the router reports it. */
  workersForActiveModel(): number | null {
    const alias = WORKLOADS[this.state.op].model;
    const m = this.state.models.find((x) => x.id === alias || x.id.startsWith(alias));
    return m?.workers ?? null;
  }

  private cancelStream(): void {
    if (this.streamAbort) {
      this.streamAbort.abort();
      this.streamAbort = null;
    }
  }

  /**
   * Send a user message under the active workload and stream the response. `source`
   * lets the summarize sub-mode pass the pasted document as the user content while a
   * separate display label is shown; here we treat `content` as both unless overridden.
   *
   * The summarize/code workloads prepend their system prompt once per send (the worker
   * is stateless per request beyond the messages we pass). A SHA-256 record_ref of the
   * user content is attached for the audit trail — it is a hash, never PHI.
   */
  async send(content: string): Promise<void> {
    const text = content.trim();
    if (!text || this.state.busy) return;

    const op = this.state.op;
    const wl = WORKLOADS[op];

    const userTurn: TranscriptTurn = {
      id: nextId(),
      role: "user",
      text,
      worker: null,
      model: null,
      op,
      streaming: false,
      error: null,
      ts: Date.now(),
    };
    const asstTurn: TranscriptTurn = {
      id: nextId(),
      role: "assistant",
      text: "",
      worker: null,
      model: null,
      op,
      streaming: true,
      error: null,
      ts: Date.now(),
    };
    this.set({ turns: [...this.state.turns, userTurn, asstTurn], busy: true });

    // Build the OpenAI messages: workload system prompt + prior thread + this turn.
    const messages: ChatMessage[] = [];
    if (wl.systemPrompt) messages.push({ role: "system", content: wl.systemPrompt });
    for (const t of this.state.turns) {
      if (t.id === asstTurn.id) continue;
      if (t.error) continue;
      messages.push({ role: t.role, content: t.text });
    }

    const recordRef = (await recordRefHash(text)) ?? undefined;

    this.streamAbort = new AbortController();
    const completionOpts = {
      model: wl.model,
      op,
      messages,
      signal: this.streamAbort.signal,
      ...(recordRef !== undefined ? { recordRef } : {}),
    };

    try {
      for await (const chunk of this.router.streamCompletion(completionOpts)) {
        this.patchTurn(asstTurn.id, (cur) => ({
          text: cur.text + chunk.delta,
          worker: chunk.worker ?? cur.worker,
          model: chunk.model ?? cur.model,
        }));
      }
      this.patchTurn(asstTurn.id, () => ({ streaming: false }));
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      this.patchTurn(asstTurn.id, (cur) => ({
        streaming: false,
        error: aborted ? "stopped" : errMsg(e),
        text: cur.text,
      }));
    } finally {
      this.streamAbort = null;
      this.set({ busy: false });
    }
  }

  /** Abort the in-flight stream (Stop button). */
  stopStream(): void {
    this.cancelStream();
  }

  private patchTurn(id: string, fn: (cur: TranscriptTurn) => Partial<TranscriptTurn>): void {
    const turns = this.state.turns.map((t) => (t.id === id ? { ...t, ...fn(t) } : t));
    this.set({ turns });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
