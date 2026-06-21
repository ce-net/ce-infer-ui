/**
 * Health / ops panel:
 *  - Version sprawl (drives the replicator update wave) — versions across the fleet.
 *  - Enrollment funnel (installed vs enrolled vs live) — aggregated across delegates.
 *  - Per-node drill-down: /history reputation (jobs hosted, earned/spent, delivered work).
 */

import type { SwarmStore } from "../stores/swarm.js";
import { el, mount } from "../lib/dom.js";
import { toast } from "../lib/toast.js";
import { shortId } from "../lib/format.js";
import { deliveredWork, type NodeHistory } from "@ce-net/sdk";

export function renderOps(store: SwarmStore, root: HTMLElement): void {
  mount(
    root,
    el(
      "div",
      { class: "ops-cols" },
      funnelCard(store),
      versionCard(store),
      drillCard(store),
    ),
  );
}

function funnelCard(store: SwarmStore): HTMLElement {
  const f = store.funnel();
  const max = Math.max(f.installed, 1);
  const bar = (label: string, n: number, cls: string) =>
    el(
      "div",
      { class: "funnel-row" },
      el("span", { class: "funnel-label" }, label),
      el(
        "div",
        { class: "funnel-track" },
        el("div", { class: `funnel-fill ${cls}`, style: `width:${Math.round((n / max) * 100)}%` }),
      ),
      el("span", { class: "funnel-n" }, String(n)),
    );

  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Enrollment funnel")),
    el(
      "div",
      { class: "card-body" },
      bar("Installed", f.installed, "installed"),
      bar("Enrolled", f.enrolled, "enrolled"),
      bar("Live", f.live, "live"),
      el(
        "div",
        { class: "advisory", style: "margin-top:10px" },
        "Installed via SCCM/Ansible · enrolled via delegate /enroll · live = serving in the atlas.",
      ),
    ),
  );
}

function versionCard(store: SwarmStore): HTMLElement {
  const sprawl = store.versionSprawl();
  const body =
    sprawl.length === 0
      ? el("div", { class: "advisory" }, "No version data in the rollups yet.")
      : el(
          "div",
          {},
          ...sprawl.map((v) =>
            el(
              "div",
              { class: "version-row" },
              el("span", { class: "mono-id" }, v.version),
              el("span", { class: "version-n" }, `${v.count} nodes`),
            ),
          ),
          sprawl.length > 1
            ? el(
                "div",
                { class: "warn-box", style: "margin-top:10px" },
                `${sprawl.length} versions in the fleet. The replicator update wave fans the ` +
                  "newest binary out in 2–3 LAN hops; SCCM/Ansible remains the install-of-record.",
              )
            : el("div", { class: "advisory", style: "margin-top:10px" }, "Fleet is on a single version."),
        );

  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Version sprawl")),
    el("div", { class: "card-body" }, body),
  );
}

function drillCard(store: SwarmStore): HTMLElement {
  const nodeInput = el("input", {
    class: "filter-input",
    style: "flex:1",
    type: "search",
    placeholder: "node id (64-hex) for reputation drill-down",
  }) as HTMLInputElement;
  const out = el("div", { class: "drill-out" });

  const run = async () => {
    const id = nodeInput.value.trim();
    if (!id) {
      toast("Enter a node id.", "warn");
      return;
    }
    out.replaceChildren(el("div", { class: "advisory" }, "Loading /history…"));
    try {
      const h = await store.history(id);
      mount(out, historyView(h));
    } catch (e) {
      mount(out, el("div", { class: "turn-error" }, `history failed: ${msg(e)}`));
    }
  };

  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Per-node reputation")),
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "drill-controls" },
        nodeInput,
        el("button", { class: "btn sm primary", onClick: () => void run() }, "Look up"),
      ),
      out,
    ),
  );
}

function historyView(h: NodeHistory): HTMLElement {
  const stat = (k: string, v: string) =>
    el("div", { class: "drill-stat" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v));
  return el(
    "div",
    {},
    el("div", { class: "drill-head" }, "node ", el("span", { class: "mono-id" }, shortId(h.nodeId))),
    el(
      "div",
      { class: "drill-grid" },
      stat("Jobs hosted", String(h.jobsHosted)),
      stat("Heartbeats hosted", String(h.heartbeatsHosted)),
      stat("Jobs paid", String(h.jobsPaid)),
      stat("Expiries", String(h.expiries)),
      stat("Delivered work", String(deliveredWork(h))),
      stat("First/last height", `${h.firstHeight} → ${h.lastHeight}`),
    ),
    h.isNewcomer() ? el("div", { class: "advisory", style: "margin-top:8px" }, "Newcomer — no recorded history.") : null,
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
