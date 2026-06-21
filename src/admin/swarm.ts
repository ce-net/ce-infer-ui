/**
 * Swarm view — the admin headline. A live grid of all ~1500 fleet nodes
 * (Tailscale-machine-list × torrent-peer-pane). Columns: node id/hostname/OS · status
 * (joining→live→idle→offline, grey→green as nodes enroll) · tier · assigned model ·
 * running jobs · last seen/uptime · tags · cap expiry. Filterable by tier/model/tag/site.
 *
 * Data: ce-fleet /fleet/rollup (aggregated atlas+status across each subtree). The grey→
 * green transition is poll-driven from the rollup status field — no per-node SSE.
 */

import type { SwarmStore } from "../stores/swarm.js";
import type { FleetNode, NodeLifecycle } from "../lib/fleet.js";
import { el, mount } from "../lib/dom.js";
import { shortId, fmtAgo, fmtUptime, fmtCountdown } from "../lib/format.js";

interface Filters {
  tier: string;
  model: string;
  tag: string;
  site: string;
  q: string;
}

const filters: Filters = { tier: "", model: "", tag: "", site: "", q: "" };

export function renderSwarm(store: SwarmStore, root: HTMLElement): void {
  const all = store.state.nodes;
  const nodes = applyFilters(all);

  const counts = lifecycleCounts(all);

  const head = el(
    "div",
    { class: "swarm-head" },
    el(
      "div",
      { class: "swarm-counts" },
      countChip("live", counts.live, "live"),
      countChip("idle", counts.idle, "idle"),
      countChip("joining", counts.joining, "joining"),
      countChip("offline", counts.offline, "offline"),
      el("span", { class: "swarm-total" }, `${all.length} nodes`),
    ),
    renderFilters(store, all, root),
  );

  const grid =
    nodes.length === 0
      ? el(
          "div",
          { class: "thread-empty" },
          el("div", { class: "sub" }, all.length === 0 ? "Awaiting rollup from delegates…" : "No nodes match the filter."),
          el(
            "div",
            { class: "advisory" },
            all.length === 0
              ? "The console polls a few regional delegate /fleet/rollup endpoints — never 1500 streams."
              : "Adjust or clear the filters above.",
          ),
        )
      : renderGrid(nodes);

  mount(root, el("div", { class: "card swarm-card" }, head, grid));
}

function renderFilters(store: SwarmStore, all: FleetNode[], root: HTMLElement): HTMLElement {
  const tiers = uniq(all.map((n) => n.tier));
  const models = uniq(all.flatMap((n) => (n.model ? [n.model] : [])));
  const tags = uniq(all.flatMap((n) => n.tags));
  const sites = uniq(store.state.rollups.map((r) => r.site));

  const rerender = () => renderSwarm(store, root);

  const search = el("input", {
    class: "filter-input",
    type: "search",
    placeholder: "search id / hostname",
    value: filters.q,
    onInput: (e: Event) => {
      filters.q = (e.target as HTMLInputElement).value;
      rerender();
    },
  });

  return el(
    "div",
    { class: "swarm-filters" },
    search,
    select("Tier", tiers, filters.tier, (v) => {
      filters.tier = v;
      rerender();
    }),
    select("Model", models, filters.model, (v) => {
      filters.model = v;
      rerender();
    }),
    select("Tag", tags, filters.tag, (v) => {
      filters.tag = v;
      rerender();
    }),
    select("Site", sites, filters.site, (v) => {
      filters.site = v;
      rerender();
    }),
  );
}

function renderGrid(nodes: FleetNode[]): HTMLElement {
  return el(
    "div",
    { class: "swarm-grid-wrap" },
    el(
      "table",
      { class: "swarm-grid" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          th("Node"),
          th("OS"),
          th("Status"),
          th("Tier"),
          th("Model"),
          th("Jobs"),
          th("Last seen"),
          th("Uptime"),
          th("Tags"),
          th("Cap expiry"),
        ),
      ),
      el("tbody", {}, ...nodes.map((n) => nodeRow(n))),
    ),
  );
}

function nodeRow(n: FleetNode): HTMLElement {
  return el(
    "tr",
    { class: `node-row ${n.status}` },
    el(
      "td",
      { class: "n-id" },
      el("span", { class: `node-dot ${n.status}` }),
      el(
        "div",
        { class: "n-id-stack" },
        el("span", { class: "n-host" }, n.hostname),
        el("span", { class: "mono-id n-nid", title: n.nodeId }, shortId(n.nodeId)),
      ),
    ),
    el("td", {}, n.os),
    el("td", {}, lifecyclePill(n.status)),
    el("td", {}, el("span", { class: "tier-pill" }, n.tier)),
    el("td", {}, n.model ? el("span", { class: "mono-id" }, n.model) : el("span", { class: "faint" }, "—")),
    el("td", { class: "num" }, String(n.runningJobs)),
    el("td", {}, fmtAgo(n.lastSeenSecs)),
    el("td", {}, n.uptimeSecs > 0 ? fmtUptime(n.uptimeSecs) : "—"),
    el("td", {}, ...n.tags.map((t) => el("span", { class: "tag" }, t))),
    el(
      "td",
      {},
      n.capExpiresAt
        ? el(
            "span",
            { class: capClass(n.capExpiresAt) },
            fmtCountdown(n.capExpiresAt - Date.now()),
          )
        : el("span", { class: "faint" }, "—"),
    ),
  );
}

function lifecyclePill(s: NodeLifecycle): HTMLElement {
  return el("span", { class: `life-pill ${s}` }, s);
}

function capClass(expiresAt: number): string {
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return "cap-exp expired";
  if (msLeft < 24 * 3600 * 1000) return "cap-exp soon";
  return "cap-exp";
}

function countChip(cls: string, n: number, label: string): HTMLElement {
  return el(
    "span",
    { class: `count-chip ${cls}` },
    el("b", {}, String(n)),
    el("span", {}, label),
  );
}

function lifecycleCounts(nodes: FleetNode[]): Record<NodeLifecycle, number> {
  const acc: Record<NodeLifecycle, number> = { joining: 0, live: 0, idle: 0, offline: 0 };
  for (const n of nodes) acc[n.status] += 1;
  return acc;
}

function applyFilters(nodes: FleetNode[]): FleetNode[] {
  const q = filters.q.trim().toLowerCase();
  return nodes.filter((n) => {
    if (filters.tier && n.tier !== filters.tier) return false;
    if (filters.model && n.model !== filters.model) return false;
    if (filters.tag && !n.tags.includes(filters.tag)) return false;
    if (filters.site && n.site !== filters.site) return false;
    if (q && !(`${n.hostname} ${n.nodeId}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function select(
  label: string,
  options: string[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const sel = el(
    "select",
    {
      class: "filter-select",
      "aria-label": label,
      onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    },
    el("option", { value: "" }, `${label}: all`),
    ...options.map((o) => {
      const attrs: Record<string, string> = { value: o };
      if (o === value) attrs["selected"] = "";
      return el("option", attrs, o);
    }),
  );
  return sel;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function th(t: string): HTMLElement {
  return el("th", {}, t);
}
