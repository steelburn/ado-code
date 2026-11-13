// VS Code glue for the turn outcome counters (roadmap #1, stage 1).
//
// Thin on purpose: the counts live in ./turnOutcome and the file in
// ./TurnOutcomeStore, both host-free. This module only renders the report in an
// editor and offers the two follow-up actions.

import * as vscode from 'vscode';

import { logger } from '../logger';
import { TurnOutcomeStore } from './TurnOutcomeStore';
import { formatOutcomeReport, summarizeOutcomeCounters } from './turnOutcome';

export async function showTurnOutcomesCommand(store: TurnOutcomeStore): Promise<void> {
  const counters = await store.read();
  const summary = summarizeOutcomeCounters(counters);
  const report = formatOutcomeReport(summary, { file: store.filePath() });

  const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  logger.info(
    `outcomes: ${summary.turns} turn(s), completion rate ${Math.round(summary.completionRate * 100)}%`
  );

  const headline =
    summary.turns === 0
      ? 'No agent turns recorded yet.'
      : `Completion rate ${Math.round(summary.completionRate * 100)}% over ${summary.turns} turn${
          summary.turns === 1 ? '' : 's'
        }.`;

  const action = await vscode.window.showInformationMessage(headline, 'Copy report', 'Clear counters');
  if (action === 'Copy report') {
    await vscode.env.clipboard.writeText(report);
    void vscode.window.showInformationMessage('Turn outcome report copied to the clipboard.');
    return;
  }
  if (action === 'Clear counters') {
    const confirm = await vscode.window.showWarningMessage(
      'Clear all recorded turn outcome counters? This resets the completion-rate baseline.',
      { modal: true },
      'Clear'
    );
    if (confirm === 'Clear') {
      await store.clear();
      void vscode.window.showInformationMessage('Turn outcome counters cleared.');
    }
  }
}
