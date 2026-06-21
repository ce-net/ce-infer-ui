import { defineConfig } from "vite";

// ce-infer-ui is a pure-web SPA, served on-LAN behind the hospital SSO reverse proxy.
//
// Two upstreams in production, both on the hospital LAN — no PHI ever leaves:
//   - the ce-infer ROUTER (OpenAI-compatible /v1/* + /healthz), behind the SSO proxy
//     that injects the per-principal identity; the browser holds no raw API token.
//   - a few regional ce-fleet DELEGATE rollup endpoints (/fleet/rollup, /enroll) and,
//     for the admin swarm view, a CE node's HTTP API consumed via @ce-net/sdk.
//
// In dev we proxy `/router/*` to a local router and `/fleet/*` + `/ce/*` to local
// services so the browser is same-origin (no CORS). Production keeps the same paths,
// resolved by the reverse proxy. Build is a static bundle (deploy like ce-host).
export default defineConfig({
  server: {
    port: 5181,
    proxy: {
      "/router": {
        target: "http://127.0.0.1:8040",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/router/, ""),
      },
      "/fleet": {
        target: "http://127.0.0.1:8070",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/fleet/, ""),
      },
      "/ce": {
        target: "http://127.0.0.1:8844",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ce/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
