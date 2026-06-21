/**
 * The reactive store driving the admin swarm console.
 *
 * Generalizes the ce-host Store from one node to the whole fleet: it polls a few
 * regional ce-fleet delegate `/fleet/rollup` endpoints (each aggregating atlas+status+
 * history over its subtree) instead of opening 1500 SSE streams. It also keeps a thin
 * @ce-net/sdk client against a CE node for the read-only on-chain bits the rollup does
 * not cover: the revoked capability set, per-node /history drill-down, and live /v1/models
 * truth via the router.
 *
 * Read panels are token-free. Mutations (enrollment-token gen, node revoke) are
 * capability-gated server-side (delegate holds the org-root cap; the admin's SSO session
 * authorizes). The browser carries no signing key.
 */

import { CeClient, type NodeHistory, type RevokedEntry } from "@ce-net/sdk";
import { FleetClient, type FleetNode, type FleetRollup } from "../lib/fleet.js";
import { RouterClient, type ModelInfo } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

export type Health = "online" | "connecting" | "offline";

export interface SwarmState {
  health: Health;
  /** Merged node list across all delegate rollups, deduped by node id. */
  nodes: FleetNode[];
  /** Per-delegate rollup (for funnel + version sprawl + freshness). */
  rollups: FleetRollup[];
  /** On-chain revoked capability set. */
  revoked: RevokedEntry[];
  /** Live model truth from the router (which ids are actually served + worker counts). */
  models: ModelInfo[];
  /** Aggregate live worker count from the router /healthz. */
  workers: number;
  error: string | null;
  lastUpdated: number;
}

type Listener = () => void;

export class SwarmStore {
  state: SwarmState;
  /** The CE node client (read-only) for revoked set + per-node history. */
  client: CeClient;
  private delegates: FleetClient[];
  private router: RouterClient;
  private listeners = new Set<Listener>();
  private timers: number[] = [];
  private abort = new AbortController();

  constructor() {
    const cfg = loadConfig();
    this.client = CeClient.withToken(cfg.nodeUrl);
    this.router = new RouterClient(cfg.routerUrl);
    this.delegates = cfg.delegates.map((d) => new FleetClient(d.url, d.site));
    this.state = {
      health: "connecting",
      nodes: [],
      rollups: [],
      revoked: [],
      models: [],
      workers: 0,
      error: null,
      lastUpdated: 0,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<SwarmState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  start(): void {
    this.stop();
    this.abort = new AbortController();
    void this.refreshRollups();
    void this.refreshRevoked();
    void this.refreshModels();
    // Rollups are aggregated server-side; a 5s poll across a few delegates is cheap and
    // smooth enough for the grey→green enrollment animation without per-node streams.
    this.timers.push(window.setInterval(() => void this.refreshRollups(), 5_000));
    this.timers.push(window.setInterval(() => void this.refreshRevoked(), 20_000));
    this.timers.push(window.setInterval(() => void this.refreshModels(), 15_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.abort.abort();
  }

  private async refreshRollups(): Promise<void> {
    if (this.delegates.length === 0) {
      this.set({ health: "offline", error: "No delegate rollup endpoints configured." });
      return;
    }
    const results = await Promise.allSettled(
      this.delegates.map((d) => d.rollup(this.abort.signal)),
    );
    const rollups: FleetRollup[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") rollups.push(r.value);
    }
    const anyOk = rollups.length > 0;
    // Dedupe nodes by id (a node can appear under at most one delegate, but be safe).
    const byId = new Map<string, FleetNode>();
    for (const ro of rollups) for (const n of ro.nodes) byId.set(n.nodeId, n);
    const nodes = [...byId.values()];

    const firstError = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;

    this.set({
      health: anyOk ? "online" : "offline",
      nodes,
      rollups,
      lastUpdated: Date.now(),
      error: anyOk ? null : firstError ? String(firstError.reason) : "All delegates unreachable.",
    });
  }

  private async refreshRevoked(): Promise<void> {
    try {
      const revoked = await this.client.capabilities.revoked();
      this.set({ revoked });
    } catch {
      // tolerate: node may be unreachable from the admin host; revoked panel shows empty
    }
  }

  private async refreshModels(): Promise<void> {
    try {
      const [models, health] = await Promise.all([
        this.router.models(this.abort.signal),
        this.router.health(this.abort.signal),
      ]);
      this.set({ models, workers: health.workers });
    } catch {
      // router may be briefly unavailable
    }
  }

  /** Per-node /history drill-down (reputation substrate). */
  async history(nodeId: string): Promise<NodeHistory> {
    return this.client.history(nodeId);
  }

  /** Aggregate enrollment funnel across all delegate subtrees. */
  funnel(): { installed: number; enrolled: number; live: number } {
    return this.state.rollups.reduce(
      (acc, r) => ({
        installed: acc.installed + r.funnel.installed,
        enrolled: acc.enrolled + r.funnel.enrolled,
        live: acc.live + r.funnel.live,
      }),
      { installed: 0, enrolled: 0, live: 0 },
    );
  }

  /** Aggregate version sprawl across delegates → drives the update wave. */
  versionSprawl(): Array<{ version: string; count: number }> {
    const acc = new Map<string, number>();
    for (const r of this.state.rollups) {
      for (const [v, c] of Object.entries(r.versions)) {
        acc.set(v, (acc.get(v) ?? 0) + c);
      }
    }
    return [...acc.entries()]
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Revoke a node's working capability on-chain (`POST /capabilities/revoke`). Requires
   * the admin to hold an org-root-derived cap; the node enforces it. Returns the tx id.
   */
  async revokeCapability(nonce: number): Promise<string> {
    return this.client.capabilities.revoke(nonce);
  }

  /** A FleetClient for the named delegate site, for enrollment-token generation. */
  delegateFor(site: string): FleetClient | null {
    const cfg = loadConfig();
    const idx = cfg.delegates.findIndex((d) => d.site === site);
    return idx >= 0 ? (this.delegates[idx] ?? null) : null;
  }
}
