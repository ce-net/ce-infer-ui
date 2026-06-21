# ce-infer-ui

Hospital clinical-inference web app: a **staff chat UI** and a **fleet admin "swarm"
console**, in one framework-free TypeScript + Vite bundle (same stack/shape as
`ce-host`). PHI never leaves the hospital LAN — all calls go to the on-LAN ce-infer
router or, for the swarm view, to regional ce-fleet delegate rollups and a CE node via
`@ce-net/sdk`.

Two surfaces, one bundle, gated by the SSO-asserted **role**:

- `clinician` → the staff clinical chat UI (Clinical Q&A / Summarize / Coding).
- `admin` → the fleet swarm console (generalizes `ce-host`).

## Run

```bash
npm install        # links @ce-net/sdk from ../ce-ts
npm run dev        # http://localhost:5181  (proxies /router, /fleet, /ce)
npm run build      # tsc --noEmit && vite build  → static dist/
npm run typecheck
```

Deploy like `ce-host`: a Vite static bundle served **on-LAN behind the SSO reverse
proxy**. The proxy authenticates the principal (OIDC/SAML) and fronts the router; the
browser holds **no raw API token**.

### Role bootstrap

`lib/principal.ts` resolves the principal + role from, in order: a
`window.__CE_INFER_PRINCIPAL__` global injected by the proxy, `<meta name="ce-principal">`
/ `<meta name="ce-role">`, `?principal=…&role=…` query params (dev/kiosk), then a dev
fallback (`clinician`, marked unauthenticated). The client-asserted role only selects
which surface renders — the router and delegates **independently enforce the
per-principal capability server-side**, so a spoofed role cannot perform privileged
actions.

## Endpoints

**Staff chat** → the ce-infer **router** (OpenAI-compatible):

- `POST /v1/chat/completions` (`stream=true` → SSE token deltas), with `X-CE-Op`
  (`chat|summarize|code`) and an optional `X-CE-Record-Ref` (SHA-256 of the source
  record for audit — **never PHI**).
- `GET /v1/models` (published ids + live worker counts).
- `GET /healthz` (live worker count for the status pill).

**Admin swarm** → ce-fleet regional **delegate rollups** + CE node via `@ce-net/sdk`:

- delegate `GET /fleet/rollup` (aggregated atlas+status+history per subtree — the browser
  talks to a few delegates, **never 1500 SSE streams**), `GET /fleet/audit`,
  `POST /enroll` (server-side `ce grant`, returns token + optional QR).
- node `GET /capabilities/revoked`, `POST /capabilities/revoke`, `GET /history/:id`
  (via `@ce-net/sdk`); router `GET /v1/models` for live-model truth.

## HIPAA / privacy posture

- **PHI stays on the LAN.** Every inference call targets the on-prem router only. The
  chat surface carries a persistent "PHI stays on this network" banner and per-answer
  provenance (serving worker node id + model).
- **Auto-logoff (§164.312(a)(2)(iii)).** `lib/idle.ts` clears the in-memory transcript
  and forces re-auth after an idle window, on screen-lock/tab-hidden, and on a
  cross-tab logoff broadcast. **Transcripts are never persisted** — memory only, wiped on
  logoff and tab close.
- **Audit carries no PHI.** The audit panel shows `record_ref` hashes only and can export
  JSONL for OCR review; a 6-year retention note is shown (operator storage policy).

## Layout

```
src/
  main.ts                 role gate → clinician chat | admin console
  app.css                 clinical light theme (high-contrast, mono ids)
  lib/
    dom.ts modal.ts toast.ts format.ts config.ts   shared (config = endpoints only, no PHI)
    workloads.ts          Chat / Summarize / Code definitions (+ system prompts)
    idle.ts               HIPAA auto-logoff watchdog
    principal.ts          SSO principal + role resolution
    router.ts             OpenAI-compatible router client + SSE streaming + record_ref hash
    fleet.ts              ce-fleet delegate rollup / audit / enroll client
  stores/
    chat.ts               clinician store (router health/models + streaming transcript)
    swarm.ts              admin store (delegate rollups + node SDK reads + revoke)
  chat/                   thread.ts statuspill.ts history.ts app.ts
  admin/                  swarm.ts models.ts trust.ts audit.ts ops.ts app.ts
```

## Stubs / follow-ups

These are client-side placeholders for **server-side, capability-gated** delegate flows
(no node changes; the node stays primitives-only):

- `admin/models.ts` — "Publish model" and "Reassign model to tier" toast that they run
  server-side (`ce-infer models publish` / an `infer:admin` worker message). Wire to the
  delegate endpoints when available. (`// TODO(delegate)`)
- Router/fleet provenance fields (worker id, model version, QR) are read defensively —
  the UI degrades gracefully when a given service does not surface them.
