import React from 'react';

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
}

interface Props {
  request: ConfirmationRequest;
  onRespond: (requestId: string, value: string) => void;
}

/**
 * Inline confirmation card: replaces native VS Code showQuickPick /
 * showWarningMessage with a presentable card inside the chat. Shows a title,
 * description, and option buttons. Rendered above the input bar so it can't
 * be missed.
 */
export function ConfirmationCard({ request, onRespond }: Props) {
  // Long option labels don't fit in a horizontal row — stack them as
  // full-width buttons so each option stays readable.
  const stacked = request.options.some((opt) => opt.label.length > 40);
  return (
    <div className="consent-card">
      <div className="consent-card-header">
        <span className="consent-card-icon">❔</span>
        <div className="consent-card-title">
          <span className="consent-card-heading">{request.title}</span>
          <span className="consent-card-sub">{request.description}</span>
        </div>
      </div>
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
