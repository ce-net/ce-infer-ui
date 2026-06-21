/**
 * The chat thread + composer (clinician surface).
 *
 * Renders the message thread and the workload-specific composer. Token text is ALWAYS
 * written via textContent (never innerHTML) — model output is never trusted as markup.
 * Under each assistant answer: a small "PHI stays on this network" provenance line with
 * the serving worker node id and the resolved model. Summarize output is marked
 * "AI-generated summary — verify against source."
 */

import type { ChatStore, TranscriptTurn } from "../stores/chat.js";
import { el, mount } from "../lib/dom.js";
import { WORKLOADS, OP_ORDER, type Op } from "../lib/workloads.js";
import { shortId } from "../lib/format.js";

export function renderThread(store: ChatStore, root: HTMLElement): void {
  const op = store.state.op;
  const wl = WORKLOADS[op];

  const selector = renderSelector(store);
  const banner = el(
    "div",
    { class: "phi-banner" },
    el("span", { class: "lock" }, "▣"),
    el("b", {}, "PHI stays on this network."),
    el(
      "span",
      { class: "phi-sub" },
      "All inference runs on on-prem workers over the hospital LAN. No data leaves the network.",
    ),
  );

  const thread =
    store.state.turns.length === 0
      ? renderEmpty(wl.label, wl.hint, op)
      : el("div", { class: "thread" }, ...store.state.turns.map((t) => renderTurn(t)));

  const composer = renderComposer(store);

  mount(
    root,
    el("div", { class: "chat-head" }, selector, el("div", { class: "chat-hint" }, wl.hint)),
    banner,
    el("div", { class: "thread-scroll", id: "thread-scroll" }, thread),
    composer,
  );

  // Keep the newest turn in view while streaming.
  const scroller = document.getElementById("thread-scroll");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function renderSelector(store: ChatStore): HTMLElement {
  return el(
    "div",
    { class: "workload-tabs", role: "tablist" },
    ...OP_ORDER.map((op) => {
      const active = store.state.op === op;
      return el(
        "button",
        {
          class: `wtab ${active ? "active" : ""}`,
          role: "tab",
          "aria-selected": active ? "true" : "false",
          onClick: () => store.setOp(op),
        },
        WORKLOADS[op].label,
      );
    }),
  );
}

function renderEmpty(label: string, hint: string, op: Op): HTMLElement {
  const lines =
    op === "summarize"
      ? "Paste a clinical note or document below, then Summarize. The output is AI-generated and must be verified against the source."
      : op === "code"
        ? "Ask for code or an explanation. Output routes to internal code-7b workers."
        : "Ask a clinical question. Answers stream from an on-prem worker and never leave the hospital network.";
  return el(
    "div",
    { class: "thread-empty" },
    el("div", { class: "big" }, label),
    el("div", { class: "sub" }, lines),
    el("div", { class: "advisory" }, hint),
  );
}

function renderTurn(t: TranscriptTurn): HTMLElement {
  const wl = WORKLOADS[t.op];
  const isAsst = t.role === "assistant";
  const bubble = el("div", {
    class: `bubble ${t.role} ${wl.mono ? "mono" : ""}`,
  });
  // textContent: model output is never markup.
  bubble.textContent = t.text || (t.streaming ? "" : t.error ? "" : "");

  if (t.streaming) bubble.append(el("span", { class: "caret" }, "▍"));

  const children: (Node | null)[] = [bubble];

  if (isAsst && t.error) {
    children.push(el("div", { class: "turn-error" }, `· ${t.error}`));
  }

  if (isAsst && t.op === "summarize" && !t.error && (t.text || !t.streaming)) {
    children.push(
      el(
        "div",
        { class: "ai-warn" },
        "AI-generated summary — verify against source.",
      ),
    );
  }

  if (isAsst && !t.streaming && !t.error) {
    children.push(renderProvenance(t));
  }

  return el("div", { class: `turn ${t.role}` }, ...children.filter((c): c is Node => !!c));
}

/** Small provenance line: serving worker node id + model, with the LAN reassurance. */
function renderProvenance(t: TranscriptTurn): HTMLElement {
  const bits: (Node | string)[] = [
    el("span", { class: "prov-lan" }, "served on-prem"),
  ];
  if (t.worker) {
    bits.push(
      el("span", { class: "sep" }, "·"),
      "worker ",
      el("span", { class: "mono-id", title: t.worker }, shortId(t.worker)),
    );
  }
  if (t.model) {
    bits.push(el("span", { class: "sep" }, "·"), "model ", el("span", { class: "mono-id" }, t.model));
  }
  return el("div", { class: "provenance" }, ...bits);
}

function renderComposer(store: ChatStore): HTMLElement {
  const op = store.state.op;
  const wl = WORKLOADS[op];
  const busy = store.state.busy;

  const isSummarize = op === "summarize";
  const input = el("textarea", {
    class: `composer-input ${wl.mono ? "mono" : ""} ${isSummarize ? "tall" : ""}`,
    placeholder: isSummarize
      ? "Paste the clinical note or document to summarize…"
      : op === "code"
        ? "Describe the code you need…"
        : "Type your clinical question…",
    rows: isSummarize ? "10" : "3",
    "aria-label": `${wl.label} input`,
  }) as HTMLTextAreaElement;

  const submit = () => {
    const v = input.value;
    if (!v.trim() || store.state.busy) return;
    input.value = "";
    void store.send(v);
  };

  // Enter to send (Shift+Enter newline) in chat/code; summarize uses the explicit button
  // because pasted documents commonly contain newlines.
  if (!isSummarize) {
    input.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        submit();
      }
    });
  }

  const action = busy
    ? el("button", { class: "btn danger", onClick: () => store.stopStream() }, "Stop")
    : el(
        "button",
        { class: "btn primary", onClick: submit },
        isSummarize ? "Summarize" : "Send",
      );

  const offline = store.state.health !== "online";

  return el(
    "div",
    { class: "composer" },
    input,
    el(
      "div",
      { class: "composer-foot" },
      el(
        "span",
        { class: "composer-note" },
        offline
          ? "Router unreachable — cannot send."
          : isSummarize
            ? "Output is AI-generated. Verify against the source."
            : "Press Enter to send · Shift+Enter for a new line",
      ),
      action,
    ),
  );
}
