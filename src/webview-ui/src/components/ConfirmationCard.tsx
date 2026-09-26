import React, { useState, useEffect } from 'react';
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
  /** Persisted minimized state across session switches / remounts */
  minimized?: boolean;
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
  /**
   * Fired when the user dismisses/closes the card (✕).
   */
  onDismiss?: (requestId: string) => void;
  /**
   * Fired when the user minimizes or expands the card.
   */
  onToggleMinimize?: (requestId: string, minimized: boolean) => void;
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
export function ConfirmationCard({ request, onRespond, onExpired, onDismiss, onToggleMinimize }: Props) {
  const [minimized, setMinimized] = useState(request.minimized ?? false);

  useEffect(() => {
    setMinimized(request.minimized ?? false);
  }, [request.requestId, request.minimized]);

  // Long option labels don't fit in a horizontal row — stack them as
  // full-width buttons so each option stays readable.
  const stacked = request.options.some((opt) => opt.label.length > 40);
  const showTimer = !!request.expiresAt;
  // On zero: clear the card only (host already auto-cancelled the flow).
  const countdown = useCountdown(request.expiresAt, () => onExpired?.(request.requestId));

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDismiss) {
      onDismiss(request.requestId);
    } else {
      onRespond(request.requestId, '');
    }
  };

  const handleToggleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !minimized;
    setMinimized(next);
    onToggleMinimize?.(request.requestId, next);
  };

  return (
    <div className={`consent-card consent-card--confirmation${minimized ? ' consent-card--minimized' : ''}`}>
      <div
        className="consent-card-header"
        onClick={minimized ? () => {
          setMinimized(false);
          onToggleMinimize?.(request.requestId, false);
        } : undefined}
        title={minimized ? 'Click to expand options' : undefined}
      >
        <span className="consent-card-icon">❔</span>
        <div className="consent-card-title">
          <span className="consent-card-heading">
            {request.title}
            {minimized && (
              <span className="consent-card-minimized-badge">
                ({request.options.length} {request.options.length === 1 ? 'option' : 'options'})
              </span>
            )}
          </span>
          {!minimized && <span className="consent-card-sub">{request.description}</span>}
        </div>
        <div className="consent-card-header-actions">
          <button
            type="button"
            className="consent-card-btn-icon"
            onClick={handleToggleMinimize}
            title={minimized ? 'Expand options' : 'Minimize options'}
            aria-label={minimized ? 'Expand options' : 'Minimize options'}
          >
            {minimized ? '+' : '−'}
          </button>
          <button
            type="button"
            className="consent-card-btn-icon"
            onClick={handleClose}
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>
      {!minimized && (
        <>
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
                type="button"
                className={opt.isDangerous ? 'btn btn-reject' : 'btn btn-approve'}
                onClick={() => onRespond(request.requestId, opt.value)}
                title={opt.label}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
