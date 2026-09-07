/**
 * Confirmation broker for in-chat confirmation cards.
 *
 * Replaces native VS Code showQuickPick / showWarningMessage dialogs with
 * presentable cards rendered inside the chat webview. The broker owns the
 * wait: it tracks the single in-flight request, resolves it from a webview
 * confirmationResponse message, and times out (denies) after 120s so the
 * extension host can never hang on a missed prompt.
 *
 * Pure module (no vscode import) so it is unit-testable.
 */

export interface ConfirmationOption {
  label: string;
  value: string;
  isDangerous?: boolean;
}

export interface ConfirmationPayload {
  title: string;
  description: string;
  options: ConfirmationOption[];
}

export interface ConfirmationRequest extends ConfirmationPayload {
  requestId: string;
  /** Absolute deadline (ms epoch) of the auto-cancel timeout. Mirrored to the
   *  webview so the card countdown tracks the host timer exactly (and survives
   *  card remounts / full-page wizard detours). */
  expiresAt: number;
}

export interface ConfirmationBroker {
  /** Register a new confirmation request; resolves with the chosen value. */
  request(payload: ConfirmationPayload): { requestId: string; decision: Promise<string | null>; expiresAt: number };
  /** Resolve a pending request from a user response (webview message). */
  resolve(requestId: string, value: string): void;
  /** Fail every pending request (webview disposed, chat cleared, turn aborted). */
  rejectAll(): void;
  /**
   * Freeze the pending request's timer, preserving the time remaining
   * (user switched away from the chat, or a full-page wizard/config is open
   * and the prompt card is not visible). A paused request cannot time out.
   */
  pause(): void;
  /**
   * Un-freeze the timer, re-based onto the frozen remaining time, and push
   * the new deadline onto `pending.expiresAt` so the host can re-post the
   * card with an accurate countdown. No-op when not paused.
   */
  resume(): void;
  /** True while the pending request's timer is frozen. */
  readonly paused: boolean;
  /** The in-flight request, if any. */
  readonly pending: ConfirmationRequest | null;
}

export function createConfirmationBroker(
  timeoutMs = 120000,
  /** Called when a request resolves because its time ran out — lets the host
   *   surface the expiry (e.g. clear the webview card). Never called when the
   *   user answered first. */
  onTimeout?: (request: ConfirmationRequest) => void
): ConfirmationBroker {
  let pendingRequest: ConfirmationRequest | null = null;
  let pendingResolve: ((value: string | null) => void) | null = null;
  let deadlineAt: number | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  // While frozen (pause), the deadline no longer advances — remaining time
  // is preserved by re-basing it onto `Date.now()` at resume().
  let frozen = false;

  function clearPending(): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    frozen = false;
    deadlineAt = undefined;
    pendingRequest = null;
    pendingResolve = null;
  }

  /** Resolve the pending request as cancelled (null), if still pending. */
  function settle(requestId: string): void {
    // Already answered/superseded? Leave the outcome alone.
    if (!pendingRequest || pendingRequest.requestId !== requestId || !pendingResolve) return;
    onTimeout?.(pendingRequest);
    pendingResolve?.(null);
    clearPending();
  }

  function arm(requestId: string): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    if (frozen || !pendingRequest || pendingRequest.requestId !== requestId) return;
    const delay = (deadlineAt ?? Date.now()) - Date.now();
    if (delay <= 0) { settle(requestId); return; }
    pendingTimer = setTimeout(() => settle(requestId), delay);
  }

  return {
    get pending() {
      return pendingRequest;
    },
    get paused() {
      return frozen;
    },
    request(payload) {
      // Only one in-flight request at a time — resolve any stale one.
      if (pendingResolve) {
        pendingResolve(null);
        clearPending();
      }
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      deadlineAt = Date.now() + timeoutMs;
      pendingRequest = { requestId, expiresAt: deadlineAt, ...payload };
      const decision = new Promise<string | null>((resolve) => {
        pendingResolve = resolve;
        arm(requestId);
      });
      return { requestId, decision, expiresAt: deadlineAt };
    },
    resolve(requestId, value) {
      if (!pendingRequest || pendingRequest.requestId !== requestId || !pendingResolve) return;
      pendingResolve(value);
      clearPending();
    },
    rejectAll() {
      if (pendingResolve) {
        pendingResolve(null);
        clearPending();
      }
    },
    pause() {
      if (frozen || !pendingRequest) return;
      frozen = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = undefined;
      // Convert the absolute deadline into REMAINING ms so time spent paused
      // never counts against the user; resume() re-bases it onto a fresh now.
      deadlineAt = Math.max(0, (deadlineAt ?? Date.now()) - Date.now());
    },
    resume() {
      if (!frozen || !pendingRequest) return;
      frozen = false;
      // deadlineAt currently holds the REMAINING ms frozen at pause().
      deadlineAt = Date.now() + (deadlineAt ?? 0);
      pendingRequest.expiresAt = deadlineAt;
      arm(pendingRequest.requestId);
    },
  };
}
