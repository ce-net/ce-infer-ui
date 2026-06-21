/**
 * Audit panel — searchable view over the audit topic + /history join (delegate
 * /fleet/audit). Per inference event: { ts, principal, worker, model+version,
 * capability id, record_ref hash, op, tokens, outcome }. Export to JSONL for OCR review.
 *
 * Explicitly shows NO PHI is present: only the record_ref hash (a SHA-256 of the source
 * record) is ever carried, never prompt/response text. 6-year retention note shown.
 */

import type { SwarmStore } from "../stores/swarm.js";
import type { AuditEvent } from "../lib/fleet.js";
import { el, mount } from "../lib/dom.js";
import { toast } from "../lib/toast.js";
import { loadConfig } from "../lib/config.js";
import { FleetClient } from "../lib/fleet.js";
import { shortId, fmtTs } from "../lib/format.js";

interface AuditFilter {
  principal: string;
  worker: string;
  op: string;
}

const flt: AuditFilter = { principal: "", worker: "", op: "" };
let loaded: AuditEvent[] = [];
let loading = false;

export function renderAudit(store: SwarmStore, root: HTMLElement): void {
  const controls = el(
    "div",
    { class: "audit-controls" },
    input("principal", "principal id", flt.principal, (v) => (flt.principal = v)),
    input("worker", "worker id", flt.worker, (v) => (flt.worker = v)),
    opSelect(),
    el("button", { class: "btn sm primary", onClick: () => void search(store, root) }, "Search"),
    el(
      "button",
      { class: "btn sm", onClick: () => exportJsonl() },
      "Export JSONL",
    ),
  );

  const phiNote = el(
    "div",
    { class: "phi-banner audit" },
    el("b", {}, "No PHI in audit records."),
    el(
      "span",
      { class: "phi-sub" },
      "Each event carries a record_ref hash only — never prompt or response text. " +
        "Retention is operator policy (HIPAA: 6 years).",
    ),
  );

  const table =
    loaded.length === 0
      ? el(
          "div",
          { class: "thread-empty" },
          el("div", { class: "sub" }, loading ? "Loading audit events…" : "No audit events loaded."),
          el("div", { class: "advisory" }, "Search to pull the most recent inference events across delegates."),
        )
      : auditTable(loaded);

  mount(
    root,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        el("h2", {}, "Audit"),
        loaded.length > 0 ? el("span", { class: "card-sub" }, `${loaded.length} events`) : null,
      ),
      el("div", { class: "card-body" }, phiNote, controls, table),
    ),
  );
}

function auditTable(events: AuditEvent[]): HTMLElement {
  return el(
    "div",
    { class: "audit-wrap" },
    el(
      "table",
      { class: "audit-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          th("Time"),
          th("Principal"),
          th("Worker"),
          th("Model"),
          th("Op"),
          th("Tokens"),
          th("Cap id"),
          th("record_ref"),
          th("Outcome"),
        ),
      ),
      el("tbody", {}, ...events.map((e) => auditRow(e))),
    ),
  );
}

function auditRow(e: AuditEvent): HTMLElement {
  const outcomeCls = e.outcome === "ok" ? "ok" : e.outcome === "denied" ? "denied" : "err";
  return el(
    "tr",
    {},
    el("td", { class: "mono-id" }, fmtTs(e.ts)),
    el("td", { class: "mono-id", title: e.principal }, shortId(e.principal)),
    el("td", { class: "mono-id", title: e.worker }, shortId(e.worker)),
    el("td", { class: "mono-id" }, e.model),
    el("td", {}, el("span", { class: "op-pill" }, e.op)),
    el("td", { class: "num" }, String(e.tokens)),
    el("td", { class: "mono-id", title: e.capabilityId }, shortId(e.capabilityId)),
    el(
      "td",
      { class: "mono-id", title: e.recordRef || "(none)" },
      e.recordRef ? shortId(e.recordRef) : el("span", { class: "faint" }, "—"),
    ),
    el("td", {}, el("span", { class: `outcome ${outcomeCls}` }, e.outcome)),
  );
}

async function search(store: SwarmStore, root: HTMLElement): Promise<void> {
  loading = true;
  renderAudit(store, root);
  const cfg = loadConfig();
  const clients = cfg.delegates.map((d) => new FleetClient(d.url, d.site));
  const q: { principal?: string; worker?: string; op?: string; limit: number } = { limit: 200 };
  if (flt.principal.trim()) q.principal = flt.principal.trim();
  if (flt.worker.trim()) q.worker = flt.worker.trim();
  if (flt.op) q.op = flt.op;

  const results = await Promise.allSettled(clients.map((c) => c.audit(q)));
  const events: AuditEvent[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") events.push(...r.value.events);
  }
  events.sort((a, b) => b.ts - a.ts);
  loaded = events;
  loading = false;
  if (events.length === 0 && results.every((r) => r.status === "rejected")) {
    toast("Audit query failed against all delegates.", "err");
  }
  renderAudit(store, root);
}

/** Export the loaded events to a JSONL file for OCR review. record_ref only — no PHI. */
function exportJsonl(): void {
  if (loaded.length === 0) {
    toast("Nothing to export — run a search first.", "warn");
    return;
  }
  const lines = loaded
    .map((e) =>
      JSON.stringify({
        ts: e.ts,
        principal: e.principal,
        worker: e.worker,
        model: e.model,
        capability_id: e.capabilityId,
        record_ref: e.recordRef,
        op: e.op,
        tokens: e.tokens,
        outcome: e.outcome,
      }),
    )
    .join("\n");
  const blob = new Blob([lines + "\n"], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = el("a", {
    href: url,
    download: `ce-infer-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${loaded.length} events.`, "ok");
}

function input(
  name: string,
  placeholder: string,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  return el("input", {
    class: "filter-input",
    type: "search",
    name,
    placeholder,
    value,
    onInput: (e: Event) => onChange((e.target as HTMLInputElement).value),
  });
}

function opSelect(): HTMLElement {
  const opts = ["", "chat", "summarize", "code"];
  return el(
    "select",
    {
      class: "filter-select",
      "aria-label": "op",
      onChange: (e: Event) => (flt.op = (e.target as HTMLSelectElement).value),
    },
    ...opts.map((o) => {
      const attrs: Record<string, string> = { value: o };
      if (o === flt.op) attrs["selected"] = "";
      return el("option", attrs, o === "" ? "op: all" : o);
    }),
  );
}

function th(t: string): HTMLElement {
  return el("th", {}, t);
}
