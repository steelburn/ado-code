import React, { useCallback, useEffect, useRef, useState } from 'react';
import { vscode } from '../../vscode';
import { DependencyReport, DependencyStatus, dependencyGate } from '../../../../shared/projectDependencies';

interface Props {
  templateId: string;
  templateOptions: Record<string, any>;
  gitInit: boolean;
  /** Lift the report so Review can warn and the create request can carry it. */
  report: DependencyReport | null;
  onReport: (report: DependencyReport | null) => void;
  /** `true` ⇒ the host runs the package install itself after scaffolding. */
  installDependencies: boolean;
  onInstallDependenciesChange: (value: boolean) => void;
  /** Required dependency missing + user ticked "continue anyway". */
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}

/**
 * Wizard step 3: can this machine actually run what we are about to scaffold?
 *
 * The host probes PATH for the template's toolchain (Node, Python, .NET SDK,
 * Flutter, PHP, Composer, Git, Pandoc) and the step renders three groups:
 *
 *  - found — nothing to do;
 *  - missing but installable by ADO Code (project packages: npm/pip/composer
 *    install) — the checkbox hands that to the host, which runs it right after
 *    the scaffold;
 *  - missing and out of reach (runtime/SDK: needs elevation, a licence or a
 *    multi-GB download) — the user gets the paste-ready per-OS command plus the
 *    download URL, a Re-check button, and has to acknowledge before continuing.
 *
 * The check never blocks creation: the scaffolder only writes files, so a
 * missing toolchain is guidance, not a veto.
 */
export function StepDependencies({
  templateId,
  templateOptions,
  gitInit,
  report,
  onReport,
  installDependencies,
  onInstallDependenciesChange,
  acknowledged,
  onAcknowledge,
}: Props) {
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const pendingId = useRef<string>('');

  const runCheck = useCallback(() => {
    const requestId = `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingId.current = requestId;
    setChecking(true);
    onReport(null);
    vscode?.postMessage({
      type: 'dependencyCheck',
      requestId,
      templateId,
      templateOptions,
      gitInit,
    });
  }, [templateId, templateOptions, gitInit, onReport]);

  // Probe on entry and whenever the answers could have changed.
  useEffect(() => {
    runCheck();
  }, [runCheck]);

  // The host answers asynchronously; ignore stale rounds (re-check, template swap).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== 'dependencyCheckResult') return;
      if (message.requestId !== pendingId.current) return;
      setChecking(false);
      onReport(message.report as DependencyReport);
      onAcknowledge(false);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onReport, onAcknowledge]);

  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable in some webview sandboxes — the text is on screen anyway */
    }
  };

  const missing = report?.checks.filter(c => !c.ok) ?? [];
  const found = report?.checks.filter(c => c.ok) ?? [];
  // Same gate the wizard's *Next* button uses, so the hint and the button agree.
  const gate = dependencyGate(report, acknowledged);
  const blocking = gate.blocking;
  const canAutoInstall = gate.canAutoInstall;

  return (
    <div className="wizard-step">
      <h3 className="wizard-step-title">Dependencies</h3>
      <p className="wizard-step-desc">
        Checking this machine for what the template needs to build and run. Missing runtimes and SDKs
        have to be installed by you — ADO Code will not install system software.
      </p>

      {checking && <div className="wizard-dep-note">Probing PATH…</div>}

      {report?.error && (
        <div className="wizard-dep-note wizard-dep-warn">
          Dependency check failed: {report.error}. You can continue — creation only writes files.
        </div>
      )}

      {!checking && report && !report.error && blocking.length === 0 && missing.length === 0 && (
        <div className="wizard-dep-note wizard-dep-ok">
          All {report.checks.length} dependencies found ({report.platform}).
        </div>
      )}

      {blocking.length > 0 && (
        <div className="wizard-dep-note wizard-dep-warn">
          {blocking.length} required {blocking.length === 1 ? 'dependency is' : 'dependencies are'} missing:{' '}
          {blocking.map(b => b.label).join(', ')}. The project will be created, but it will not run until
          {blocking.length === 1 ? ' it is' : ' they are'} installed.
        </div>
      )}

      <div className="wizard-dep-list">
        {missing.map(dep => (
          <DependencyCard key={dep.id} dep={dep} copied={copied} onCopy={copy} />
        ))}
        {found.map(dep => (
          <DependencyCard key={dep.id} dep={dep} copied={copied} onCopy={copy} />
        ))}
      </div>

      {canAutoInstall && (
        <label className="wizard-dep-auto">
          <input
            type="checkbox"
            checked={installDependencies}
            onChange={e => onInstallDependenciesChange(e.target.checked)}
          />
          <span>
            Install project dependencies automatically after creation (
            {report!.autoInstall.map(s => s.label).join(', ')})
          </span>
        </label>
      )}

      {blocking.length > 0 && (
        <label className="wizard-dep-auto">
          <input type="checkbox" checked={acknowledged} onChange={e => onAcknowledge(e.target.checked)} />
          <span>
            I will install {blocking.map(b => b.label).join(', ')} myself — continue for now.
          </span>
        </label>
      )}

      <div className="wizard-dep-actions">
        <button className="wizard-btn" onClick={runCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}

function DependencyCard({
  dep,
  copied,
  onCopy,
}: {
  dep: DependencyStatus;
  copied: string | null;
  onCopy: (text: string) => void;
}) {
  const badge = dep.ok ? 'found' : dep.required ? 'missing' : 'optional';
  return (
    <div className={`wizard-dep-card ${dep.ok ? 'is-ok' : dep.required ? 'is-missing' : 'is-optional'}`}>
      <div className="wizard-dep-head">
        <span className="wizard-dep-name">{dep.label}</span>
        <span className={`wizard-dep-badge is-${badge}`}>
          {badge}
          {dep.ok && dep.version ? ` ${dep.version}` : ''}
        </span>
      </div>
      <div className="wizard-dep-why">{dep.why}</div>

      {!dep.ok && (
        <>
          {dep.error && <div className="wizard-dep-error">{dep.error}</div>}
          {dep.guidance.map(line => (
            <div className="wizard-next-step-command" key={line}>
              <code>{line}</code>
              <button
                type="button"
                className="wizard-btn wizard-btn-secondary wizard-copy-btn"
                onClick={() => onCopy(line)}
              >
                {copied === line ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
          {dep.url && (
            <div className="wizard-dep-url">
              Download: <code>{dep.url}</code>
            </div>
          )}
          {dep.note && <div className="wizard-dep-note-inline">{dep.note}</div>}
        </>
      )}
    </div>
  );
}
