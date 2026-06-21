/**
 * Trust / enrollment panel (the ce-host capabilities panel + fleet additions).
 *
 *  - Topology: the org root + regional delegates (from app config).
 *  - Active enrollment tokens with TTL countdown + scope (local log of tokens generated
 *    through this console; the authoritative one-time-nonce tracking lives in the delegate).
 *  - "Generate enrollment token" → delegate POST /enroll (server-side `ce grant`), returns
 *    token (+ optional QR). Capability-gated: the delegate holds the org-root cap; the
 *    admin's SSO session authorizes. The browser carries no signing key.
 *  - On-chain revoked set (GET /capabilities/revoked) + "Revoke node"
 *    (POST /capabilities/revoke) — submits an on-chain RevokeCapability tx.
 */

import type { SwarmStore } from "../stores/swarm.js";
import { el, mount } from "../lib/dom.js";
import { confirmModal } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { loadConfig, saveConfig, type IssuedEnrollToken } from "../lib/config.js";
import { shortId, fmtCountdown } from "../lib/format.js";

const ENROLL_ABILITIES = ["status", "infer:chat"];

export function renderTrust(store: SwarmStore, root: HTMLElement): void {
  const cfg = loadConfig();

  mount(
    root,
    el(
      "div",
      { class: "trust-cols" },
      topologyCard(store),
      enrollmentCard(store, root, cfg.enrollTokens),
      revokedCard(store, root),
    ),
  );
}

function topologyCard(store: SwarmStore): HTMLElement {
  const cfg = loadConfig();
  const delegates = cfg.delegates;
  return el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, "Trust topology")),
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "trust-node root" },
        el("span", { class: "trust-badge" }, "ORG ROOT"),
        el("span", { class: "advisory" }, "offline signing key — anchors every capability chain"),
      ),
      el(
        "div",
        { class: "trust-delegates" },
        ...delegates.map((d) =>
          el(
            "div",
            { class: "trust-node delegate" },
            el("span", { class: "trust-badge dim" }, "DELEGATE"),
            el("span", {}, d.site),
            el("span", { class: "mono-id faint" }, d.url),
          ),
        ),
      ),
      el(
        "div",
        { class: "advisory", style: "margin-top:10px" },
        `${store.state.nodes.length} enrolled nodes under ${delegates.length} delegate(s). ` +
          "Every hop attenuates: abilities intersected, expiry clamped, audience fixed.",
      ),
    ),
  );
}

function enrollmentCard(
  store: SwarmStore,
  root: HTMLElement,
  tokens: IssuedEnrollToken[],
): HTMLElement {
  const active = tokens.filter((t) => t.notAfter > Date.now());
  const list =
    active.length === 0
      ? el("div", { class: "advisory" }, "No active enrollment tokens.")
      : el(
          "div",
          {},
          ...active.map((t) =>
            el(
              "div",
              { class: "enroll-row" },
              el(
                "div",
                {},
                el("span", { class: "enroll-scope" }, t.scope),
                el("div", { class: "abilities" }, "can: " + t.abilities.join(",")),
                el("div", { class: "meta" }, `${t.site} · TTL `, el("b", {}, fmtCountdown(t.notAfter - Date.now()))),
              ),
              el(
                "button",
                {
                  class: "btn sm ghost",
                  onClick: () => {
                    void navigator.clipboard?.writeText(t.token);
                    toast("Enrollment token copied", "ok");
                  },
                },
                "copy token",
              ),
            ),
          ),
        );

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h2", {}, "Enrollment"),
      el(
        "div",
        { class: "right" },
        el(
          "button",
          { class: "btn sm primary", onClick: () => void generate(store, root) },
          "Generate token",
        ),
      ),
    ),
    el("div", { class: "card-body" }, list),
  );
}

function revokedCard(store: SwarmStore, root: HTMLElement): HTMLElement {
  const revoked = store.state.revoked;
  const list =
    revoked.length === 0
      ? el("div", { class: "advisory" }, "No revocations on-chain.")
      : el(
          "div",
          {},
          ...revoked.map((r) =>
            el(
              "div",
              { class: "grant-row" },
              el("span", { class: "meta" }, `issuer ${shortId(r.issuer)} · nonce ${r.nonce}`),
              el("span", { class: "pill settled", style: "margin-left:auto" }, "revoked"),
            ),
          ),
        );

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h2", {}, "Revocation"),
      el(
        "div",
        { class: "right" },
        el(
          "button",
          { class: "btn sm danger", onClick: () => void revokeNode(store, root) },
          "Revoke node",
        ),
      ),
    ),
    el(
      "div",
      { class: "card-body" },
      el("div", { class: "section-label" }, "Revoked (on-chain)"),
      list,
    ),
  );
}

async function generate(store: SwarmStore, root: HTMLElement): Promise<void> {
  const cfg = loadConfig();
  const siteSel = el(
    "select",
    { class: "cap-input", style: "width:100%" },
    ...cfg.delegates.map((d) => el("option", { value: d.site }, d.site)),
  ) as HTMLSelectElement;
  const scope = el("input", {
    class: "cap-input",
    style: "width:100%",
    placeholder: "scope tag, e.g. tag=radiology",
    value: "tag=",
  }) as HTMLInputElement;
  const abilities = el("input", {
    class: "cap-input",
    style: "width:100%",
    value: ENROLL_ABILITIES.join(","),
  }) as HTMLInputElement;
  const ttl = el("input", {
    class: "cap-input",
    style: "width:100%",
    type: "number",
    min: "1",
    value: "2",
  }) as HTMLInputElement;

  const form = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:10px" },
    field("Delegate", siteSel),
    field("Scope", scope),
    field("Abilities (comma-separated)", abilities),
    field("TTL (hours)", ttl),
    el(
      "div",
      { class: "warn-box" },
      "The delegate generates this token server-side via `ce grant` against the org-root " +
        "cap. It is one-time-nonce tracked. Mutations require an admin holding an " +
        "org-root-derived capability.",
    ),
  );

  const ok = await confirmModal({
    title: "Generate enrollment token",
    body: form,
    confirmLabel: "Generate",
  });
  if (!ok) return;

  const site = siteSel.value;
  const scopeVal = scope.value.trim();
  const abilityList = abilities.value.split(",").map((s) => s.trim()).filter(Boolean);
  const ttlHours = Number(ttl.value);
  if (!scopeVal || abilityList.length === 0 || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    toast("Scope, abilities, and a positive TTL are required.", "err");
    return;
  }

  const delegate = store.delegateFor(site);
  if (!delegate) {
    toast("Selected delegate is not configured.", "err");
    return;
  }

  try {
    const res = await delegate.generateEnrollToken(scopeVal, abilityList, ttlHours * 3600);
    const entry: IssuedEnrollToken = {
      scope: res.scope,
      abilities: res.abilities,
      notAfter: res.notAfter,
      token: res.token,
      issuedAt: Date.now(),
      site,
    };
    saveConfig({ enrollTokens: [entry, ...loadConfig().enrollTokens] });
    void navigator.clipboard?.writeText(res.token);
    toast("Enrollment token generated and copied.", "ok");
    if (res.qr) showQr(res.qr, scopeVal);
    renderTrust(store, root);
  } catch (e) {
    toast(`Token generation failed: ${msg(e)}`, "err", 6000);
  }
}

/** Show a QR returned by the delegate (data-URL image or text payload) in a modal. */
function showQr(qr: string, scope: string): void {
  const isImg = qr.startsWith("data:image");
  const body = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:10px;align-items:center" },
    isImg
      ? el("img", { src: qr, alt: `enrollment QR for ${scope}`, style: "width:220px;height:220px" })
      : el("div", { class: "mono-id", style: "word-break:break-all" }, qr),
    el("div", { class: "advisory" }, "Scan from a kiosk's Tauri tray to enroll it."),
  );
  void confirmModal({ title: `Enrollment QR — ${scope}`, body, confirmLabel: "Done", cancelLabel: "Close" });
}

async function revokeNode(store: SwarmStore, root: HTMLElement): Promise<void> {
  const nonceInput = el("input", {
    class: "cap-input",
    style: "width:100%",
    type: "number",
    placeholder: "capability nonce to revoke",
  }) as HTMLInputElement;
  const body = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:10px" },
    field("Capability nonce", nonceInput),
    el(
      "div",
      { class: "warn-box" },
      "Submits an on-chain RevokeCapability tx. The node — and anyone it delegated to — " +
        "loses these abilities once mined (~a minute). This cannot be undone; you would " +
        "re-enroll the node to restore it.",
    ),
  );

  const ok = await confirmModal({
    title: "Revoke node capability",
    body,
    confirmLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;

  const nonce = Number(nonceInput.value);
  if (!Number.isFinite(nonce)) {
    toast("A numeric nonce is required.", "err");
    return;
  }

  try {
    const txId = await store.revokeCapability(nonce);
    toast(`Revoke submitted (${shortId(txId)}).`, "ok");
    renderTrust(store, root);
  } catch (e) {
    toast(`Revoke failed: ${msg(e)}`, "err", 6000);
  }
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el(
    "label",
    { style: "display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--faint)" },
    label,
    input,
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
