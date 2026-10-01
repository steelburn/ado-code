import { useEffect, useRef } from 'react';
import { ERROR_AUTO_DISMISS_MS } from '../../utils/errorBanner';

/** Shared top-of-panel error banner.
 *
 *  Rendered by both the chat view (App) and the Configuration page — the config
 *  page used to duplicate this markup and its auto-dismiss timer because App
 *  early-returns the config page before the global banner is mounted.
 *
 *  Auto-dismisses after ERROR_AUTO_DISMISS_MS. The callback is held in a ref so
 *  an inline-arrow prop (new identity every render) does not restart the timer. */
export function ErrorBanner({ message, onDismiss }: {
  message: string | null;
  onDismiss: () => void;
}) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => dismissRef.current(), ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <div className="error-banner">
      <span className="error-banner-text">{message}</span>
      <button className="error-banner-dismiss" onClick={() => dismissRef.current()} title="Dismiss">✕</button>
    </div>
  );
}
