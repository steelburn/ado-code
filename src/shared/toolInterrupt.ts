/**
 * Interrupt-on-message contract.
 *
 * When the user sends a new message while a tool call is in flight, the run is
 * NOT aborted as a whole (that would discard the turn). Instead the in-flight
 * tool is *cancelled* — its per-tool AbortSignal fires — and the new message is
 * injected as a `user` turn on the next iteration. A cancelled tool reports the
 * machine-readable result below so the model can see that the command was cut
 * short by the user and re-plan, rather than receiving an opaque transport
 * error.
 *
 * Kept as pure functions so the semantics can be unit-tested without spawning
 * processes or an LLM.
 */

/** Reason recorded when the user's new message cancelled an in-flight tool. */
export const USER_INTERRUPT_REASON = 'cancelled by a new user message';

/**
 * Build the JSON result a tool returns when it was cancelled mid-flight by a
 * new user message.
 */
export function interruptedToolResult(reason: string = USER_INTERRUPT_REASON): string {
  return JSON.stringify({ interrupted: true, reason });
}

/**
 * True when `content` is the result produced by {@link interruptedToolResult}.
 * Cheaply guards on the leading brace before attempting a JSON parse.
 */
export function isToolInterruptResult(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0 || content.charAt(0) !== '{') {
    return false;
  }
  try {
    const parsed = JSON.parse(content);
    return !!parsed && parsed.interrupted === true;
  } catch {
    return false;
  }
}

/**
 * Decide whether an in-flight tool should be cancelled, given its interrupt
 * signal. A tool is interrupted only when a signal exists AND has already
 * fired — a missing signal (e.g. a non-terminal tool, or a run that never
 * registered one) is never interrupted.
 */
export function shouldInterruptTool(signal?: { aborted: boolean } | null): boolean {
  return !!signal && signal.aborted === true;
}
