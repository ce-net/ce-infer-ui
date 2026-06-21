/**
 * Idle / auto-logoff watchdog — HIPAA §164.312(a)(2)(iii).
 *
 * A hospital workstation must not leave a clinical transcript on screen after the
 * clinician walks away. This watchdog fires `onIdle` after `idleSeconds` with no user
 * activity, after which the chat surface wipes its in-memory transcript and forces
 * re-auth. It also fires on the page Visibility `hidden` → screen-lock proxy and on
 * an explicit `storage` "logoff" broadcast so locking one tab clears the others.
 *
 * The watchdog tracks nothing about the user and persists nothing.
 */

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

const LOGOFF_CHANNEL = "ce-infer-ui.logoff";

export interface IdleWatch {
  /** Reset the countdown (call after a successful re-auth). */
  poke(): void;
  /** Broadcast a logoff to every tab and fire this tab's handler. */
  logoffAll(): void;
  /** Tear down all listeners. */
  stop(): void;
  /** Seconds remaining before idle fires (for an optional countdown UI). */
  remaining(): number;
}

export function startIdleWatch(idleSeconds: number, onIdle: () => void): IdleWatch {
  let last = Date.now();
  let fired = false;
  const idleMs = Math.max(15, idleSeconds) * 1000;

  const poke = () => {
    last = Date.now();
    fired = false;
  };

  const fire = () => {
    if (fired) return;
    fired = true;
    onIdle();
  };

  const onActivity = () => {
    if (!fired) last = Date.now();
  };

  const tick = window.setInterval(() => {
    if (!fired && Date.now() - last >= idleMs) fire();
  }, 1000);

  const onVisibility = () => {
    // Screen lock / tab hidden is treated as "stepped away": fire immediately so the
    // transcript is never left rendered behind a lock screen.
    if (document.visibilityState === "hidden") fire();
  };

  const onStorage = (e: StorageEvent) => {
    if (e.key === LOGOFF_CHANNEL && e.newValue) fire();
  };

  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, onActivity, { passive: true });
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("storage", onStorage);

  const logoffAll = () => {
    try {
      // Bumping the value broadcasts a `storage` event to sibling tabs.
      localStorage.setItem(LOGOFF_CHANNEL, String(Date.now()));
    } catch {
      // private mode — same-tab fire still happens below
    }
    fire();
  };

  const stop = () => {
    clearInterval(tick);
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("storage", onStorage);
  };

  const remaining = () => Math.max(0, Math.ceil((idleMs - (Date.now() - last)) / 1000));

  return { poke, logoffAll, stop, remaining };
}
