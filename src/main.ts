/**
 * ce-infer-ui — app entry.
 *
 * Two surfaces in one bundle, gated by the SSO-asserted role:
 *   - `clinician` → the staff clinical chat UI (Chat / Summarize / Code, streaming),
 *   - `admin`     → the fleet "swarm" console (generalizes ce-host).
 *
 * Auth is the hospital SSO reverse proxy in front of this app and the ce-infer router;
 * the proxy asserts the principal + role (see lib/principal.ts) and injects the
 * per-principal identity the router maps to a CE capability. The browser holds no raw
 * API token, and the router/delegates enforce capabilities server-side regardless of the
 * client-asserted role.
 *
 * DEPLOY (like ce-host): a Vite static bundle served on-LAN behind the SSO proxy.
 */

import "./app.css";
import { resolvePrincipal } from "./lib/principal.js";
import { createClinicianApp } from "./chat/app.js";
import { createAdminApp } from "./admin/app.js";

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app root");
}

const principal = resolvePrincipal();
const label = shortPrincipal(principal.id);

if (principal.role === "admin") {
  document.title = "Fleet console — clinical inference";
  createAdminApp(label).mount(root);
} else {
  document.title = "Clinical AI — on-prem";
  createClinicianApp(label).mount(root);
}

/** A compact principal label for the rail (full id is title-tooltipped where shown). */
function shortPrincipal(id: string): string {
  if (id.length <= 20) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}
