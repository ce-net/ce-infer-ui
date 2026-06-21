/**
 * Admin "swarm" console shell — generalizes ce-host's shell from one node to the fleet.
 *
 * Owns the SwarmStore lifecycle and navigation across the five admin screens:
 * Swarm · Models · Trust/Enrollment · Audit · Ops. A single reactive store fans out to
 * the panels; live-data panels (swarm) re-render on each store change, while form/action
 * panels (trust, audit) re-render only on explicit interaction so a half-typed field is
 * never clobbered by a background rollup poll.
 */

import { SwarmStore } from "../stores/swarm.js";
import { el, mount } from "../lib/dom.js";
import { fmtAgo } from "../lib/format.js";
import { renderSwarm } from "./swarm.js";
import { renderModels } from "./models.js";
import { renderTrust } from "./trust.js";
import { renderAudit } from "./audit.js";
import { renderOps } from "./ops.js";

type AdminView = "swarm" | "models" | "trust" | "audit" | "ops";

interface NavSpec {
  id: AdminView;
  label: string;
}

const NAV: NavSpec[] = [
  { id: "swarm", label: "Swarm" },
  { id: "models", label: "Models" },
  { id: "trust", label: "Trust & enrollment" },
  { id: "audit", label: "Audit" },
  { id: "ops", label: "Health / ops" },
];

export interface AdminApp {
  mount(root: HTMLElement): void;
  stop(): void;
}

export function createAdminApp(principalLabel: string): AdminApp {
  const store = new SwarmStore();
  let view: AdminView = "swarm";

  const railEl = el("aside", { class: "rail" });
  const topEl = el("div", { class: "admin-top" });
  const viewEl = el("div", { class: "admin-view" });

  function go(v: AdminView): void {
    view = v;
    renderAll();
  }

  function renderRail(): void {
    const live = store.state.nodes.filter((n) => n.status === "live").length;
    mount(
      railEl,
      el(
        "div",
        { class: "brand" },
        el("div", { class: "mark" }),
        el("div", { class: "name" }, "Fleet console", el("small", {}, "clinical inference")),
      ),
      ...NAV.map((n) =>
        el(
          "div",
          {
            class: `nav-item ${view === n.id ? "active" : ""}`,
            onClick: () => go(n.id),
          },
          el("span", {}, n.label),
          n.id === "swarm" && live > 0 ? el("span", { class: "badge" }, String(live)) : null,
        ),
      ),
      el("div", { class: "spacer" }),
      el(
        "div",
        { class: "rail-foot" },
        el("div", { class: "mono-id" }, principalLabel),
        store.state.lastUpdated
          ? `updated ${fmtAgo((Date.now() - store.state.lastUpdated) / 1000)} ago`
          : "—",
      ),
    );
  }

  function renderTop(): void {
    const s = store.state;
    const dot = s.health === "online" ? "dot on" : s.health === "connecting" ? "dot warn" : "dot off";
    const f = store.funnel();
    mount(
      topEl,
      el(
        "div",
        { class: "admin-headbar" },
        el(
          "div",
          { class: "admin-state" },
          el("span", { class: dot }),
          el("span", { class: "who" }, s.health === "online" ? "FLEET ONLINE" : s.health === "connecting" ? "CONNECTING" : "DELEGATES UNREACHABLE"),
        ),
        el(
          "div",
          { class: "admin-stats" },
          stat("Nodes", String(s.nodes.length)),
          stat("Live", String(f.live)),
          stat("Workers", String(s.workers)),
          stat("Models", String(s.models.length)),
          stat("Revoked", String(s.revoked.length)),
        ),
        el("span", { class: "hipaa-tag" }, "HIPAA · on-prem"),
      ),
      s.error ? el("div", { class: "admin-error" }, s.error) : null,
    );
  }

  function renderView(): void {
    switch (view) {
      case "swarm":
        renderSwarm(store, viewEl);
        break;
      case "models":
        renderModels(store, viewEl);
        break;
      case "trust":
        renderTrust(store, viewEl);
        break;
      case "audit":
        renderAudit(store, viewEl);
        break;
      case "ops":
        renderOps(store, viewEl);
        break;
    }
  }

  function renderAll(): void {
    renderRail();
    renderTop();
    renderView();
  }

  /** Live re-render on store change: rail + top always; the view only when data-driven. */
  function renderLive(): void {
    renderRail();
    renderTop();
    if (view === "swarm" || view === "models" || view === "ops") renderView();
  }

  return {
    mount(root: HTMLElement): void {
      mount(root, el("div", { class: "admin-shell" }, railEl, el("main", { class: "main" }, topEl, viewEl)));
      store.subscribe(() => renderLive());
      window.setInterval(() => renderLive(), 1000);
      store.start();
      renderAll();
    },
    stop(): void {
      store.stop();
    },
  };
}

function stat(k: string, v: string): HTMLElement {
  return el("div", { class: "stat" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v));
}
