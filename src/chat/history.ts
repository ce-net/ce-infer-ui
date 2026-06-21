/**
 * This clinician's own session list — LOCAL ONLY, derived from the in-memory transcript.
 * Nothing is persisted; the list is cleared on idle-logoff and tab close along with the
 * transcript. It groups the live transcript into "exchanges" (a user turn + its answer)
 * so the clinician can scan what they have asked this session.
 */

import type { ChatStore, TranscriptTurn } from "../stores/chat.js";
import { el, mount } from "../lib/dom.js";
import { WORKLOADS } from "../lib/workloads.js";
import { fmtClock } from "../lib/format.js";

export function renderHistory(store: ChatStore, root: HTMLElement): void {
  const turns = store.state.turns;
  const exchanges = pairUp(turns);

  if (exchanges.length === 0) {
    mount(
      root,
      el(
        "div",
        { class: "card" },
        el("div", { class: "card-head" }, el("h2", {}, "This session")),
        el(
          "div",
          { class: "card-body" },
          el(
            "div",
            { class: "thread-empty small" },
            el("div", { class: "sub" }, "No questions yet this session."),
            el(
              "div",
              { class: "advisory" },
              "Your session history is held in memory only and is cleared when you log off " +
                "or the workstation locks. Nothing is stored.",
            ),
          ),
        ),
      ),
    );
    return;
  }

  mount(
    root,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h2", {}, "This session"),
        el("span", { class: "card-sub" }, `${exchanges.length} exchange${exchanges.length === 1 ? "" : "s"}`),
      ),
      el(
        "div",
        { class: "card-body" },
        el("div", { class: "session-list" }, ...exchanges.map((x) => row(x))),
        el(
          "div",
          { class: "advisory", style: "margin-top:14px" },
          "Local to this session and this workstation. Cleared on logoff / lock.",
        ),
      ),
    ),
  );
}

interface Exchange {
  question: string;
  op: TranscriptTurn["op"];
  ts: number;
  answered: boolean;
}

function pairUp(turns: TranscriptTurn[]): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (!t || t.role !== "user") continue;
    const next = turns[i + 1];
    out.push({
      question: t.text,
      op: t.op,
      ts: t.ts,
      answered: !!next && next.role === "assistant" && !next.streaming && !next.error,
    });
  }
  return out.reverse();
}

function row(x: Exchange): HTMLElement {
  return el(
    "div",
    { class: "session-row" },
    el("span", { class: "s-op" }, WORKLOADS[x.op].label),
    el("span", { class: "s-q" }, truncate(x.question, 96)),
    el("span", { class: "s-time" }, fmtClock(x.ts)),
    el("span", { class: `s-state ${x.answered ? "ok" : "pending"}` }, x.answered ? "answered" : "…"),
  );
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}
