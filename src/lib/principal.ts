/**
 * Resolve the authenticated principal + role from the SSO reverse proxy.
 *
 * Authentication is the hospital SSO (OIDC/SAML) reverse proxy in front of the app and
 * the router. The browser holds NO raw API token. The proxy makes the principal identity
 * + role available to the SPA via one of (checked in order):
 *
 *   1. a `window.__CE_INFER_PRINCIPAL__` global injected into index.html by the proxy,
 *   2. `<meta name="ce-principal" content="…">` / `<meta name="ce-role" content="…">`,
 *   3. query params `?principal=…&role=…` (dev / kiosk bootstrap),
 *   4. a dev fallback (clinician) so the chat is usable without a proxy in local dev.
 *
 * Role gates which surface renders: `clinician` → staff chat; `admin` → swarm console.
 * The proxy is the source of truth — this never grants a role the proxy did not assert;
 * the router/delegates independently enforce the per-principal capability server-side, so
 * a spoofed client role cannot perform privileged actions.
 */

import type { Role } from "./config.js";

export interface Principal {
  /** Display label / identity (e.g. SSO subject or mapped CE node id). */
  id: string;
  role: Role;
  /** True when resolved from a real proxy assertion (not the dev fallback). */
  authenticated: boolean;
}

interface InjectedPrincipal {
  id?: string;
  principal?: string;
  role?: string;
}

declare global {
  interface Window {
    __CE_INFER_PRINCIPAL__?: InjectedPrincipal;
  }
}

function toRole(s: string | null | undefined): Role | null {
  if (s === "admin" || s === "fleet-admin" || s === "fleet_admin") return "admin";
  if (s === "clinician" || s === "staff" || s === "clinical") return "clinician";
  return null;
}

function meta(name: string): string | null {
  const m = document.querySelector(`meta[name="${name}"]`);
  return m ? m.getAttribute("content") : null;
}

export function resolvePrincipal(): Principal {
  // 1. Injected global.
  const g = window.__CE_INFER_PRINCIPAL__;
  if (g) {
    const id = g.id ?? g.principal;
    const role = toRole(g.role);
    if (id && role) return { id, role, authenticated: true };
  }

  // 2. Meta tags.
  const metaId = meta("ce-principal");
  const metaRole = toRole(meta("ce-role"));
  if (metaId && metaRole) return { id: metaId, role: metaRole, authenticated: true };

  // 3. Query params (dev / kiosk bootstrap).
  const params = new URLSearchParams(window.location.search);
  const qpId = params.get("principal");
  const qpRole = toRole(params.get("role"));
  if (qpId && qpRole) return { id: qpId, role: qpRole, authenticated: true };

  // 4. Dev fallback — clinician chat usable without a proxy. NOT treated as authenticated.
  const devRole = toRole(params.get("role")) ?? "clinician";
  return { id: "dev-principal", role: devRole, authenticated: false };
}
