/** Display formatters. No money math here (the router speaks tokens, not credits). */

/** Short node-id form: first 4 + last 4 hex chars, e.g. `7f3a…be45`. */
export function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Seconds-ago to a compact "12s" / "3m" / "now". */
export function fmtAgo(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs < 2) return "now";
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** `512MB` / `8GB` from megabytes. */
export function fmtMem(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  if (mb >= 1024) {
    const gb = mb / 1024;
    return Number.isInteger(gb) ? `${gb}GB` : `${gb.toFixed(1)}GB`;
  }
  return `${mb}MB`;
}

/** Coarse uptime `Dd HHh` / `HHh MMm` / `MMm`. */
export function fmtUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** ms-until countdown as "2h 14m" / "47s" / "expired". */
export function fmtCountdown(msUntil: number): string {
  if (msUntil <= 0) return "expired";
  const s = Math.floor(msUntil / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Local wall-clock time for an epoch-ms timestamp, HH:MM:SS. */
export function fmtClock(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

/** ISO-ish `YYYY-MM-DD HH:MM:SS` for audit rows. */
export function fmtTs(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
