/**
 * Client for the ce-fleet regional DELEGATE rollup service (PLAN §6 / §09).
 *
 * The admin console must show ~1500 nodes without opening 1500 SSE streams from the
 * browser. Instead it polls a few regional delegate `/fleet/rollup` endpoints, each of
 * which aggregates `ce.atlas() + /status + /history` across its own subtree. The browser
 * talks to a handful of delegates, not the whole fleet.
 *
 * Read panels are token-free (rollup is a read aggregation). Mutations — enrollment-token
 * generation and node revocation — are capability-gated server-side: the delegate holds
 * the org-root-derived cap and performs `ce grant` / on-chain revoke. The browser sends
 * the request; the admin's SSO session authorizes it at the proxy. No raw token here.
 */

export type NodeLifecycle = "joining" | "live" | "idle" | "offline";

export interface FleetNode {
  nodeId: string;
  hostname: string;
  os: string;
  status: NodeLifecycle;
  /** Capability tier from ce-infer probe, e.g. "GpuHeavy" | "CpuLow". */
  tier: string;
  /** Assigned/serving model id, or null if none. */
  model: string | null;
  /** Running inference jobs right now. */
  runningJobs: number;
  /** Seconds since last atlas/status freshness. */
  lastSeenSecs: number;
  /** Node uptime in seconds, if known. */
  uptimeSecs: number;
  tags: string[];
  /** Working-cap expiry as epoch ms, or null if unknown/non-expiring. */
  capExpiresAt: number | null;
  /** Site/delegate this node rolled up under. */
  site: string;
}

export interface FleetRollup {
  /** Delegate site label this rollup came from. */
  site: string;
  /** Aggregated nodes in this delegate's subtree. */
  nodes: FleetNode[];
  /** Enrollment funnel for the subtree. */
  funnel: { installed: number; enrolled: number; live: number };
  /** Version → count, drives the replicator update wave. */
  versions: Record<string, number>;
  /** Generated-at epoch ms (rollup freshness). */
  generatedAt: number;
}

export interface AuditEvent {
  /** Event timestamp, epoch ms. */
  ts: number;
  /** Principal (clinician) node/identity id. */
  principal: string;
  /** Worker node id that served. */
  worker: string;
  /** Model id + version, e.g. "clinical-chat-8b@1.2". */
  model: string;
  /** Hash of the presented capability chain (provenance, not the chain itself). */
  capabilityId: string;
  /** SHA-256 of the source record — NEVER PHI. May be empty for chat. */
  recordRef: string;
  op: "chat" | "summarize" | "code";
  tokens: number;
  /** "ok" | "denied" | "error: <reason>". */
  outcome: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Cursor for the next (older) page, or null when exhausted. */
  nextBefore: number | null;
}

export interface EnrollTokenResult {
  token: string;
  /** Scope tag, e.g. "tag=radiology". */
  scope: string;
  abilities: string[];
  /** Expiry epoch ms. */
  notAfter: number;
  /** Optional QR payload (data URL or text) the delegate may return. */
  qr: string | null;
}

/** Raw wire shapes from the delegate (snake_case). */
interface RawFleetNode {
  node_id: string;
  hostname?: string;
  os?: string;
  status?: string;
  tier?: string;
  model?: string | null;
  running_jobs?: number;
  last_seen_secs?: number;
  uptime_secs?: number;
  tags?: string[];
  cap_expires_at?: number | null;
}

interface RawRollup {
  site?: string;
  nodes?: RawFleetNode[];
  funnel?: { installed?: number; enrolled?: number; live?: number };
  versions?: Record<string, number>;
  generated_at?: number;
}

interface RawAuditEvent {
  ts: number;
  principal: string;
  worker: string;
  model: string;
  capability_id: string;
  record_ref?: string;
  op: string;
  tokens?: number;
  outcome: string;
}

const LIFECYCLE: ReadonlySet<string> = new Set(["joining", "live", "idle", "offline"]);

function toLifecycle(s: string | undefined): NodeLifecycle {
  return s && LIFECYCLE.has(s) ? (s as NodeLifecycle) : "offline";
}

function toOp(s: string): AuditEvent["op"] {
  return s === "summarize" || s === "code" ? s : "chat";
}

export class FleetClient {
  constructor(
    private readonly baseUrl: string,
    private readonly site: string,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  /** `GET /fleet/rollup` — aggregated atlas+status+history over this delegate's subtree. */
  async rollup(signal?: AbortSignal): Promise<FleetRollup> {
    const init: RequestInit = { method: "GET", credentials: "include" };
    if (signal) init.signal = signal;
    const r = await this.fetchImpl(this.url("/fleet/rollup"), init);
    if (!r.ok) throw new Error(`GET /fleet/rollup (${this.site}) → ${r.status}`);
    const raw = (await r.json()) as RawRollup;
    const site = raw.site ?? this.site;
    const nodes: FleetNode[] = (raw.nodes ?? []).map((n) => ({
      nodeId: n.node_id,
      hostname: n.hostname ?? "—",
      os: n.os ?? "—",
      status: toLifecycle(n.status),
      tier: n.tier ?? "—",
      model: n.model ?? null,
      runningJobs: n.running_jobs ?? 0,
      lastSeenSecs: n.last_seen_secs ?? Number.POSITIVE_INFINITY,
      uptimeSecs: n.uptime_secs ?? 0,
      tags: n.tags ?? [],
      capExpiresAt: n.cap_expires_at ?? null,
      site,
    }));
    return {
      site,
      nodes,
      funnel: {
        installed: raw.funnel?.installed ?? nodes.length,
        enrolled: raw.funnel?.enrolled ?? nodes.filter((n) => n.status !== "joining").length,
        live: raw.funnel?.live ?? nodes.filter((n) => n.status === "live").length,
      },
      versions: raw.versions ?? {},
      generatedAt: raw.generated_at ?? Date.now(),
    };
  }

  /**
   * `GET /fleet/audit` — searchable audit feed (audit topic + /history join). The
   * delegate guarantees record_ref-only (no PHI). Pagination via `before` cursor.
   */
  async audit(
    q: { principal?: string; worker?: string; op?: string; before?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<AuditPage> {
    const params = new URLSearchParams();
    if (q.principal) params.set("principal", q.principal);
    if (q.worker) params.set("worker", q.worker);
    if (q.op) params.set("op", q.op);
    if (q.before !== undefined) params.set("before", String(q.before));
    params.set("limit", String(q.limit ?? 100));
    const init: RequestInit = { method: "GET", credentials: "include" };
    if (signal) init.signal = signal;
    const r = await this.fetchImpl(this.url(`/fleet/audit?${params.toString()}`), init);
    if (!r.ok) throw new Error(`GET /fleet/audit (${this.site}) → ${r.status}`);
    const body = (await r.json()) as { events?: RawAuditEvent[]; next_before?: number | null };
    const events: AuditEvent[] = (body.events ?? []).map((e) => ({
      ts: e.ts,
      principal: e.principal,
      worker: e.worker,
      model: e.model,
      capabilityId: e.capability_id,
      recordRef: e.record_ref ?? "",
      op: toOp(e.op),
      tokens: e.tokens ?? 0,
      outcome: e.outcome,
    }));
    return { events, nextBefore: body.next_before ?? null };
  }

  /**
   * `POST /enroll` token generation. The delegate (holding an org-root cap) runs
   * `ce grant` server-side and returns the enrollment token + optional QR. The admin's
   * SSO session authorizes this; the browser carries no signing key.
   */
  async generateEnrollToken(
    scope: string,
    abilities: string[],
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<EnrollTokenResult> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, abilities, ttl_seconds: ttlSeconds }),
      credentials: "include",
    };
    if (signal) init.signal = signal;
    const r = await this.fetchImpl(this.url("/enroll"), init);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`enroll token gen failed (${r.status})${t ? `: ${t.slice(0, 200)}` : ""}`);
    }
    const body = (await r.json()) as {
      token: string;
      scope?: string;
      abilities?: string[];
      not_after?: number;
      qr?: string;
    };
    return {
      token: body.token,
      scope: body.scope ?? scope,
      abilities: body.abilities ?? abilities,
      notAfter: body.not_after ?? Date.now() + ttlSeconds * 1000,
      qr: body.qr ?? null,
    };
  }
}
