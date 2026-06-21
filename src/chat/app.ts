/**
 * Clinician chat surface shell.
 *
 * Owns: the ChatStore lifecycle, navigation between Chat and History, the status pill,
 * and the idle/auto-logoff lock (HIPAA §164.312(a)(2)(iii)) — on idle it wipes the
 * in-memory transcript and shows a re-auth lock overlay. Re-auth here is a local gesture
 * ("Resume session"): real authentication is the SSO reverse proxy in front of the
 * router; this overlay guarantees the transcript is not left on screen and that a fresh
 * session is started after a lock. The proxy re-challenges on the next request if the
 * SSO session itself expired.
 */

import { ChatStore } from "../stores/chat.js";
import { el, mount } from "../lib/dom.js";
import { startIdleWatch, type IdleWatch } from "../lib/idle.js";
import { loadConfig } from "../lib/config.js";
import { renderThread } from "./thread.js";
import { renderHistory } from "./history.js";
import { renderStatusPill } from "./statuspill.js";

type ChatView = "chat" | "history";

export interface ClinicianApp {
  mount(root: HTMLElement): void;
  stop(): void;
}

export function createClinicianApp(principalLabel: string): ClinicianApp {
  const store = new ChatStore();
  let view: ChatView = "chat";
  let locked = false;
  let idle: IdleWatch | null = null;
  let host: HTMLElement | null = null;

  const pillEl = el("div", {});
  const viewEl = el("div", { class: "chat-view" });
  const railEl = el("aside", { class: "c-rail" });

  function go(v: ChatView): void {
    view = v;
    renderAll();
  }

  function renderRail(): void {
    const items: Array<[ChatView, string]> = [
      ["chat", "Chat"],
      ["history", "Session"],
    ];
    mount(
      railEl,
      el(
        "div",
        { class: "c-brand" },
        el("div", { class: "c-mark" }, "＋"),
        el("div", { class: "c-name" }, "Clinical AI", el("small", {}, "on-prem")),
      ),
      ...items.map(([id, label]) =>
        el(
          "button",
          {
            class: `c-nav ${view === id ? "active" : ""}`,
            onClick: () => go(id),
          },
          label,
        ),
      ),
      el("div", { class: "c-spacer" }),
      el(
        "div",
        { class: "c-principal" },
        el("div", { class: "c-principal-label" }, "Signed in"),
        el("div", { class: "c-principal-id mono-id" }, principalLabel),
        el(
          "button",
          { class: "btn ghost sm", onClick: () => lockNow() },
          "Lock & log off",
        ),
      ),
    );
  }

  function renderView(): void {
    if (view === "chat") renderThread(store, viewEl);
    else renderHistory(store, viewEl);
  }

  function renderAll(): void {
    renderRail();
    renderStatusPill(store, pillEl);
    renderView();
  }

  function lockNow(): void {
    if (locked) return;
    locked = true;
    // Wipe transcript from memory before anything is rendered behind the lock.
    store.wipeTranscript();
    idle?.logoffAll();
    showLock();
  }

  function showLock(): void {
    if (!host) return;
    const overlay = el(
      "div",
      { class: "lock-overlay", role: "dialog", "aria-modal": "true" },
      el(
        "div",
        { class: "lock-card" },
        el("div", { class: "lock-mark" }, "▣"),
        el("h2", {}, "Session locked"),
        el(
          "p",
          {},
          "For patient privacy this session was cleared. No transcript is retained.",
        ),
        el(
          "p",
          { class: "advisory" },
          "Re-authenticate to start a new session. PHI never left this network.",
        ),
        el(
          "button",
          { class: "btn primary lock-resume", onClick: () => resume() },
          "Resume session",
        ),
      ),
    );
    mount(host, overlay);
  }

  function resume(): void {
    locked = false;
    idle?.poke();
    buildShell();
    renderAll();
  }

  function buildShell(): void {
    if (!host) return;
    const top = el(
      "header",
      { class: "c-topbar" },
      pillEl,
      el("div", { class: "c-top-right" }, el("span", { class: "hipaa-tag" }, "HIPAA · on-prem")),
    );
    const main = el("main", { class: "c-main" }, top, viewEl);
    mount(host, el("div", { class: "c-shell" }, railEl, main));
  }

  return {
    mount(root: HTMLElement): void {
      host = root;
      const cfg = loadConfig();
      idle = startIdleWatch(cfg.idleSeconds, () => lockNow());
      store.subscribe(() => {
        if (!locked) {
          renderStatusPill(store, pillEl);
          renderView();
        }
      });
      store.start();
      buildShell();
      renderAll();
    },
    stop(): void {
      idle?.stop();
      store.stop();
    },
  };
}
