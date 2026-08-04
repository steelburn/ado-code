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
}

export interface ConfirmationBroker {
  /** Register a new confirmation request; resolves with the chosen value. */
  request(payload: ConfirmationPayload): { requestId: string; decision: Promise<string | null> };
  /** Resolve a pending request from a user response (webview message). */
  resolve(requestId: string, value: string): void;
  /** Fail every pending request (webview disposed, chat cleared, turn aborted). */
  rejectAll(): void;
  /** The in-flight request, if any. */
  readonly pending: ConfirmationRequest | null;
}

export function createConfirmationBroker(timeoutMs = 120000): ConfirmationBroker {
  let pendingRequest: ConfirmationRequest | null = null;
  let pendingResolve: ((value: string | null) => void) | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  function clearPending(): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    pendingRequest = null;
    pendingResolve = null;
  }

  return {
    get pending() {
      return pendingRequest;
    },
    request(payload) {
      // Only one in-flight request at a time — resolve any stale one.
      if (pendingResolve) {
        pendingResolve(null);
        clearPending();
      }
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      pendingRequest = { requestId, ...payload };
      const decision = new Promise<string | null>((resolve) => {
        pendingResolve = resolve;
        pendingTimer = setTimeout(() => {
          // User never answered — cancel.
          pendingResolve?.(null);
          clearPending();
        }, timeoutMs);
      });
      return { requestId, decision };
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
  };
}
