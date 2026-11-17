
/**
 * Structural view of `AddServiceResult` — kept here so the formatter stays
 * pure and testable, with no import of the webview service class.
 */
export interface AddServiceReport {
  ok: boolean;
  error?: string;
  service?: string;
  stack?: string;
  kind?: string;
  port?: number;
  files?: string[];
  written?: string[];
  patched?: string[];
  warnings?: string[];
  envKeys?: string[];
  dryRun?: boolean;
  /** Present on a dry run: the compose patch and the files it would write. */
  preview?: { compose: string; files: string[] };
  postCreateSteps?: Array<{ label: string; command?: string; detail?: string }>;
}

/**
 * One Markdown summary for `/new-service`, the palette command and the chat.
 * Split out of the callers so all three entry points word the result the same
 * way — and so the wording is covered by a test instead of three ad-hoc strings.
 */
export function describeAddServiceResult(result: AddServiceReport): string {
  if (!result.ok) {
    return `**Could not add the service.** ${result.error ?? 'Unknown error.'}`;
  }
  const lines: string[] = [];
  const pushWarnings = () => {
    if (result.warnings && result.warnings.length > 0) {
      lines.push('', 'Warnings:', ...result.warnings.map(warning => `- ${warning}`));
    }
  };
  const what = result.dryRun ? 'Preview' : 'Added';
  const port = result.port ? `, port ${result.port}` : '';
  lines.push(`**${what}: \`${result.service}\`** — ${result.kind ?? 'api'} service (${result.stack}${port}).`);
  if (result.dryRun) {
    lines.push('', 'Nothing was written. Re-run without `--dry-run` to create it.', '', 'Files:');
    for (const file of result.files ?? []) {
      lines.push(`- \`${file}\``);
    }
    if (result.envKeys && result.envKeys.length > 0) {
      lines.push('', '`.env.example` keys:', ...result.envKeys.map(key => `- \`${key}\``));
    }
    pushWarnings();
    return lines.join('\n');
  }
  if (result.written && result.written.length > 0) {
    lines.push('', `Created ${result.written.length} file(s):`);
    for (const file of result.written) {
      lines.push(`- \`${file}\``);
    }
  }
  if (result.patched && result.patched.length > 0) {
    lines.push('', 'Extended in place:', ...result.patched.map(file => `- \`${file}\``));
  }
  if (result.postCreateSteps && result.postCreateSteps.length > 0) {
    lines.push('', 'Next:');
    for (const step of result.postCreateSteps) {
      lines.push(`- ${step.label}${step.command ? ` — \`${step.command}\`` : ''}`);
    }
  }
  pushWarnings();
  return lines.join('\n');
}
