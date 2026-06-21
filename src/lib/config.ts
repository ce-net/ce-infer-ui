/**
 * App-local persisted config — endpoints and non-PHI preferences only.
 *
 * NOTHING clinical is persisted: chat transcripts live only in volatile memory and are
 * wiped on idle-logoff (see lib/idle.ts) and on tab close. This store holds the router
 * base URL, the few regional ce-fleet delegate rollup URLs, the CE node base URL used by
 * @ce-net/sdk for the swarm view, the idle-timeout, and the local-only enrollment-token
 * log (admin). No API tokens are ever stored: auth is the SSO reverse proxy in front of
 * the router, which injects the per-principal identity. The browser holds no raw token.
 */

const KEY = "ce-infer-ui.config.v1";

export type Role = "clinician" | "admin";

export interface DelegateRef {
  /** Human site label, e.g. "North campus". */
  site: string;
  /** Base URL of the delegate's rollup service (/fleet/rollup, /enroll). */
  url: string;
}

/** A locally-logged enrollment token the admin generated through this console. */
export interface IssuedEnrollToken {
  /** Tag scope, e.g. "tag=radiology". */
  scope: string;
  abilities: string[];
  /** Epoch ms the token stops being valid. */
  notAfter: number;
  /** The opaque token string returned by the delegate /enroll generator. */
  token: string;
  issuedAt: number;
  /** Issuing delegate site label. */
  site: string;
}

export interface AppConfig {
  /** OpenAI-compatible router base (SSO proxy sits in front). Same-origin `/router` in dev. */
  routerUrl: string;
  /** CE node HTTP API base for @ce-net/sdk swarm reads. Same-origin `/ce` in dev. */
  nodeUrl: string;
  /** A few regional delegate rollup endpoints — never 1500 SSE streams (see PLAN §6). */
  delegates: DelegateRef[];
  /** Idle seconds before auto-logoff wipes the transcript + forces re-auth (HIPAA). */
  idleSeconds: number;
  /** Local-only log of enrollment tokens generated through the admin console. */
  enrollTokens: IssuedEnrollToken[];
}

function defaults(): AppConfig {
  return {
    routerUrl: "/router",
    nodeUrl: "/ce",
    delegates: [{ site: "Primary delegate", url: "/fleet" }],
    // HIPAA workstation auto-logoff (§164.312(a)(2)(iii)). 5 minutes is a common
    // hospital default; operator-configurable in the chat settings.
    idleSeconds: 300,
    enrollTokens: [],
  };
}

let cache: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      cache = { ...defaults(), ...(JSON.parse(raw) as Partial<AppConfig>) };
      return cache;
    }
  } catch {
    // ignore malformed storage; fall through to defaults
  }
  cache = defaults();
  return cache;
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage may be unavailable (private mode); keep in-memory only
  }
  return next;
}
