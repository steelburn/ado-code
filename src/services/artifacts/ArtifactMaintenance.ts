// VS Code glue for the ArtifactStore (ADO-27356) and the context cost
// diagnostic (ADO-27361): settings resolution, the throttled activation-time
// prune, and the two commands. All policy logic lives in ArtifactStore /
// contextCost so it stays unit-testable without the extension host.

import * as vscode from 'vscode';

import { logger } from '../logger';
import {
  formatBytes,
  formatPruneReport,
  PrunePolicy,
  pruneArtifacts,
  resolvePrunePolicy,
  runScheduledPrune,
} from './ArtifactStore';
import {
  buildContextCostReport,
  ContextCostLimits,
  DEFAULT_CONTEXT_COST_LIMITS,
  formatContextCostReport,
} from './contextCost';

/** Delay before the automatic prune so it never competes with activation work. */
const SCHEDULED_PRUNE_DELAY_MS = 5000;

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * `adoCode.artifacts.enabled` — false stops ALL automatic deletion while the
 * Compact Artifacts command keeps working (AC: the manual path stays available).
 */
export function artifactsEnabled(): boolean {
  return vscode.workspace.getConfiguration('adoCode').get<boolean>('artifacts.enabled', true);
}

export function policyFromSettings(): PrunePolicy {
  const config = vscode.workspace.getConfiguration('adoCode');
  return resolvePrunePolicy({
    retentionDays: config.get<number>('artifacts.retentionDays'),
    maxFilesPerKind: config.get<number>('artifacts.maxFilesPerKind'),
  });
}

export function limitsFromSettings(): ContextCostLimits {
  const config = vscode.workspace.getConfiguration('adoCode');
  return {
    ...DEFAULT_CONTEXT_COST_LIMITS,
    memoryMaxTotalChars:
      config.get<number>('memory.maxTotalChars') ?? DEFAULT_CONTEXT_COST_LIMITS.memoryMaxTotalChars,
    memoryMaxEntries:
      config.get<number>('memory.maxEntries') ?? DEFAULT_CONTEXT_COST_LIMITS.memoryMaxEntries,
    understandingMaxEntries:
      config.get<number>('understanding.maxEntries') ??
      DEFAULT_CONTEXT_COST_LIMITS.understandingMaxEntries,
    skillsMaxInjectedChars:
      config.get<number>('skills.maxInjectedChars') ??
      DEFAULT_CONTEXT_COST_LIMITS.skillsMaxInjectedChars,
  };
}

/**
 * Activation-time GC. Throttled to once a day by `.ado-code/.prune-stamp.json`,
 * quiet unless it actually removed something, and never allowed to throw into
 * activation.
 */
export function scheduleArtifactPrune(): void {
  const root = getWorkspaceRoot();
  if (!root) {
    return;
  }
  const timer = setTimeout(() => {
    try {
      const report = runScheduledPrune(root, {
        enabled: artifactsEnabled(),
        policy: policyFromSettings(),
      });
      if (report && (report.deleted > 0 || report.errors.length > 0)) {
        logger.info(formatPruneReport(report));
      }
    } catch (err) {
      logger.warn(`Artifact prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, SCHEDULED_PRUNE_DELAY_MS);
  // Never hold the extension host open just for housekeeping.
  (timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * `ADO Code: Compact Artifacts` — dry run first, show the exact reclaim, require
 * explicit confirmation, then delete. Works even when the setting is off.
 */
export async function compactArtifactsCommand(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage('Open a folder to compact ADO Code artifacts.');
    return;
  }
  const policy = policyFromSettings();
  const plan = pruneArtifacts(root, { policy, dryRun: true });
  if (plan.candidates.length === 0) {
    vscode.window.showInformationMessage(
      'ADO Code artifacts are within budget — nothing to compact.'
    );
    return;
  }
  const confirmLabel = `Delete ${plan.deleted} file(s)`;
  const choice = await vscode.window.showWarningMessage(
    `Compact ADO Code artifacts? This permanently deletes ${plan.deleted} generated file(s) and reclaims ${formatBytes(plan.bytesFreed)} from .ado-code.`,
    { modal: true },
    confirmLabel
  );
  if (choice !== confirmLabel) {
    return;
  }
  const report = pruneArtifacts(root, { policy });
  logger.info(formatPruneReport(report));
  const summary = `Removed ${report.deleted} file(s), reclaimed ${formatBytes(report.bytesFreed)}.`;
  const action = await vscode.window.showInformationMessage(summary, 'Show details');
  if (action === 'Show details') {
    logger.getChannel()?.show(true);
  }
}

/**
 * `ADO Code: Show Context Cost` — report only. Nothing is written to disk; the
 * report can be copied to the clipboard on request.
 */
export async function showContextCostCommand(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showInformationMessage('Open a folder to inspect ADO Code context cost.');
    return;
  }
  const report = buildContextCostReport(root, { limits: limitsFromSettings() });
  const text = formatContextCostReport(report);
  logger.info(text);

  const overBudget = report.budgets.filter(b => b.over).length;
  const summary = `~${report.totalTokens} tokens across ${report.totalFiles} file(s), ${formatBytes(report.totalBytes)}${
    overBudget > 0 ? ` — ${overBudget} budget(s) over limit` : ''
  }.`;
  const action = await vscode.window.showInformationMessage(summary, 'Copy report', 'Show in output');
  if (action === 'Copy report') {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Context cost report copied to the clipboard.');
  } else if (action === 'Show in output') {
    logger.getChannel()?.show(true);
  }
}
