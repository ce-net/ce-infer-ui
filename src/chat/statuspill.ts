/**
 * The "On-prem · LAN-only · N workers online" status pill, plus the per-model live count
 * for the active workload. Data: router GET /healthz (live worker count) and GET /v1/models.
 */

import type { ChatStore } from "../stores/chat.js";
import { el, mount } from "../lib/dom.js";

export function renderStatusPill(store: ChatStore, root: HTMLElement): void {
  const s = store.state;
  const dot =
    s.health === "online" ? "dot on" : s.health === "connecting" ? "dot warn" : "dot off";
  const workersWord =
    s.health === "online"
      ? `${s.workers} worker${s.workers === 1 ? "" : "s"} online`
      : s.health === "connecting"
        ? "connecting…"
        : "router offline";

  const perModel = store.workersForActiveModel();

  mount(
    root,
    el(
      "div",
      { class: "status-pill", title: "Inference runs on on-prem workers only." },
      el("span", { class: dot }),
      el("span", { class: "pill-strong" }, "On-prem"),
      el("span", { class: "pill-sep" }, "·"),
      el("span", {}, "LAN-only"),
      el("span", { class: "pill-sep" }, "·"),
      el("span", {}, workersWord),
      perModel !== null
        ? el(
            "span",
            { class: "pill-aux" },
            `(${perModel} for this workload)`,
          )
        : null,
    ),
  );
}
