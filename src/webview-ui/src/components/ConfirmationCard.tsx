import React from 'react';
import { useCountdown, formatCountdown } from './ui/useCountdown';

export interface ConfirmationOption {
  label: string;
  value: string;
  isDangerous?: boolean;
}

export interface ConfirmationRequest {
  requestId: string;
  title: string;
  description: string;
  options: ConfirmationOption[];
  /** True when rendered from an AI choice prompt (option click sends the choice as a message). */
  isChoice?: boolean;
  /**
   * Absolute deadline (epoch ms) of the host-enforced auto-cancel timeout.
   * Choice prompts (isChoice) have no broker/timeout and never carry one —
   * they stay until answered. System confirmations do: the card shows a
   * countdown and the host cancels the waiting flow when it expires.
   */
  expiresAt?: number;
}

interface Props {
  request: ConfirmationRequest;
  onRespond: (requestId: string, value: string) => void;
  /**
   * Fired when the countdown reaches zero (auto-cancel). The HOST already
   * resolved the waiting flow as cancelled — this only clears the card
   * locally, never fabricates an option value (callers treat no-answer as
   * cancel; sending a made-up value could trigger the wrong branch).
   */
  onExpired?: (requestId: string) => void;
}

/**
 * Inline confirmation card: replaces native VS Code showQuickPick /
 * showWarningMessage with a presentable card inside the chat. Shows a title,
 * description, and option buttons. Rendered above the input bar so it can't
 * be missed.
 *
 * System confirmations count down to their host-enforced auto-cancel
 * deadline ("Auto-cancelling in m:ss") so the user always sees how long the
 * prompt stays open and what happens if they don't answer. Choice prompts
 * rendered from AI offers carry no deadline and never auto-cancel.
 */
export function ConfirmationCard({ request, onRespond, onExpired }: Props) {
  // Long option labels don't fit in a horizontal row — stack them as
  // full-width buttons so each option stays readable.
  const stacked = request.options.some((opt) => opt.label.length > 40);
  const showTimer = !!request.expiresAt;
  // On zero: clear the card only (host already auto-cancelled the flow).
  const countdown = useCountdown(request.expiresAt, () => onExpired?.(request.requestId));

  return (
    <div className="consent-card">
      <div className="consent-card-header">
        <span className="consent-card-icon">❔</span>
        <div className="consent-card-title">
          <span className="consent-card-heading">{request.title}</span>
          <span className="consent-card-sub">{request.description}</span>
        </div>
      </div>
      {showTimer && countdown && countdown.remainingMs > 0 && (
        <div className="consent-card-timer">
          <div className="consent-card-timer-bar">
            <div
              className="consent-card-timer-fill"
              style={{ width: `${(countdown.remainingMs / Math.max(1, countdown.totalMs)) * 100}%` }}
            />
          </div>
          <span className="consent-card-timer-text">
            Auto-cancelling in {formatCountdown(countdown.remainingMs)} — choose an option to keep it open
          </span>
        </div>
      )}
      <div className={`consent-card-actions${stacked ? ' consent-card-actions--stack' : ''}`}>
        {request.options.map((opt) => (
          <button
            key={opt.value}
            className={opt.isDangerous ? 'btn btn-reject' : 'btn btn-approve'}
            onClick={() => onRespond(request.requestId, opt.value)}
            title={opt.label}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
