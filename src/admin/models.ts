/**
 * Models panel — which model ids are published (CIDs), per-tier assignment, and replica
 * health across the LAN.
 *
 * Live model truth comes from the router GET /v1/models (which ids are actually served +
 * worker counts), cross-referenced with the fleet rollup (which tiers/nodes are assigned
 * each model). Replica/availability health is derived from how many live workers serve
 * each model right now.
 *
 * Two mutating actions are capability-gated and performed SERVER-SIDE:
 *  - "Publish model" → `ce-infer models publish` on a delegate (put_object → CID,
 *    update models.toml, ce-pin replicate). The browser cannot read a GGUF off disk or
 *    sign the registry; it only triggers the server flow. Marked TODO until the delegate
 *    publish endpoint is wired.
 *  - "Reassign model to tier" → an infer:admin message to workers (server-side). TODO.
 */

import type { SwarmStore } from "../stores/swarm.js";
import type { FleetNode } from "../lib/fleet.js";
import type { ModelInfo } from "../lib/router.js";
import { el, mount } from "../lib/dom.js";
import { toast } from "../lib/toast.js";

export interface ModelRow {
  id: string;
  liveWorkers: number;
  assignedNodes: number;
  tiers: string[];
  publishedInRouter: boolean;
}

export function renderModels(store: SwarmStore, root: HTMLElement): void {
  const rows = buildRows(store.state.models, store.state.nodes);

  const table =
    rows.length === 0
      ? el(
          "div",
          { class: "thread-empty" },
          el("div", { class: "sub" }, "No models published yet."),
          el("div", { class: "advisory" }, "Publish a GGUF to make it available across the LAN."),
        )
      : el(
          "table",
          { class: "models-table" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              th("Model id"),
              th("Live workers"),
              th("Assigned nodes"),
              th("Tiers"),
              th("Replica health"),
            ),
          ),
          el("tbody", {}, ...rows.map((r) => modelRow(r))),
        );

  mount(
    root,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h2", {}, "Models"),
        el(
          "div",
          { class: "right" },
          el(
            "button",
            { class: "btn sm", onClick: () => publishModel() },
            "Publish model",
          ),
        ),
      ),
      el(
        "div",
        { class: "card-body" },
        table,
        el(
          "div",
          { class: "advisory", style: "margin-top:12px" },
          "Models are content-addressed GGUFs (CIDs) replicated across the LAN by ce-pin. " +
            "Each worker pulls its model from peers that already hold it — air-gap native.",
        ),
      ),
    ),
  );
}

function modelRow(r: ModelRow): HTMLElement {
  const health = replicaHealth(r.liveWorkers);
  return el(
    "tr",
    {},
    el(
      "td",
      {},
      el("span", { class: "mono-id" }, r.id),
      r.publishedInRouter ? null : el("span", { class: "pill warn", style: "margin-left:8px" }, "registry-only"),
    ),
    el("td", { class: "num" }, String(r.liveWorkers)),
    el("td", { class: "num" }, String(r.assignedNodes)),
    el("td", {}, r.tiers.length ? el("span", { class: "faint" }, r.tiers.join(", ")) : el("span", { class: "faint" }, "—")),
    el(
      "td",
      {},
      el("span", { class: `replica ${health.cls}` }, health.label),
      el(
        "button",
        {
          class: "btn ghost xs",
          style: "margin-left:10px",
          onClick: () => reassign(r.id),
        },
        "Reassign to tier",
      ),
    ),
  );
}

export function buildRows(models: ModelInfo[], nodes: FleetNode[]): ModelRow[] {
  const byModel = new Map<string, { nodes: number; tiers: Set<string> }>();
  for (const n of nodes) {
    if (!n.model) continue;
    const e = byModel.get(n.model) ?? { nodes: 0, tiers: new Set<string>() };
    e.nodes += 1;
    e.tiers.add(n.tier);
    byModel.set(n.model, e);
  }

  const ids = new Set<string>([...models.map((m) => m.id), ...byModel.keys()]);
  const rows: ModelRow[] = [];
  for (const id of ids) {
    const m = models.find((x) => x.id === id);
    const fleet = byModel.get(id);
    // Live workers: prefer the router's count; else infer from assigned live fleet nodes.
    const liveWorkers = m?.workers ?? fleet?.nodes ?? 0;
    rows.push({
      id,
      liveWorkers,
      assignedNodes: fleet?.nodes ?? 0,
      tiers: fleet ? [...fleet.tiers].sort() : [],
      publishedInRouter: !!m,
    });
  }
  return rows.sort((a, b) => b.liveWorkers - a.liveWorkers);
}

export function replicaHealth(liveWorkers: number): { cls: string; label: string } {
  if (liveWorkers === 0) return { cls: "bad", label: "no replicas" };
  if (liveWorkers < 3) return { cls: "warn", label: `${liveWorkers} replica${liveWorkers === 1 ? "" : "s"} (low)` };
  return { cls: "ok", label: `${liveWorkers} replicas` };
}

/** TODO(delegate): wire to the delegate's `ce-infer models publish` endpoint. */
function publishModel(): void {
  toast(
    "Publish runs server-side (ce-infer models publish): put_object → CID, update models.toml, ce-pin replicate. Delegate endpoint not yet wired.",
    "warn",
    6000,
  );
}

/** TODO(delegate): wire to an infer:admin reassign message to workers (server-side). */
function reassign(id: string): void {
  toast(`Reassign "${id}" runs server-side via an infer:admin message. Not yet wired.`, "warn", 6000);
}

function th(t: string): HTMLElement {
  return el("th", {}, t);
}
