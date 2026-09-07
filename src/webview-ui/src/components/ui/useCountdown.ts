import { useEffect, useRef, useState } from 'react';

export interface CountdownState {
  /** Milliseconds left until the deadline (0 once it passed). */
  remainingMs: number;
  /** Full duration of the window, captured when the deadline was first seen
   *  (used for progress-bar fill; approximate when the card remounts after a
   *  full-page wizard/config detour — the text is the source of truth). */
  totalMs: number;
}

/**
 * Countdown to an ABSOLUTE deadline (epoch ms). Ticks ~5×/second and fires
 * `onExpire` exactly once, immediately after the deadline passes.
 *
 * Returns null when there is no deadline — callers render no timer at all.
 * Because the deadline is absolute (not a duration reset on mount), the
 * countdown survives card remounts (e.g. returning from the full-page
 * Configuration page via Back) and stays in sync with the host-side timer
 * that actually enforces the timeout.
 */
export function useCountdown(expiresAt?: number, onExpire?: () => void): CountdownState | null {
  const [state, setState] = useState<CountdownState | null>(() =>
    expiresAt
      ? { remainingMs: Math.max(0, expiresAt - Date.now()), totalMs: Math.max(1, expiresAt - Date.now()) }
      : null
  );
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const firedRef = useRef(false);

  useEffect(() => {
    if (!expiresAt) {
      setState(null);
      return;
    }
    firedRef.current = false;
    const tick = () => {
      const remainingMs = Math.max(0, expiresAt - Date.now());
      // totalMs: keep the first-seen window (progress bar), never shrink.
      setState(prev => ({
        remainingMs,
        totalMs: Math.max(prev?.totalMs ?? remainingMs, remainingMs),
      }));
      if (remainingMs <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpireRef.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [expiresAt]);

  return state;
}

/** Render a remaining duration as m:ss (e.g. "1:59", "0:08"). */
export function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
