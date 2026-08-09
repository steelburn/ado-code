/**
 * Slash command definitions and utilities shared between
 * the extension host (ChatViewProvider) and the webview (InputBar).
 */

export interface SlashCommand {
  /** The command name without the leading slash (e.g. "status") */
  name: string;
  /** Human-readable description shown in autocomplete */
  description: string;
  /** Usage pattern shown next to the description */
  usage: string;
  /** Whether the command requires arguments after the name */
  requiresArgs: boolean;
}

/**
 * All supported slash commands.
 * Order matters — this is the default display order in the autocomplete dropdown.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'status',    description: 'Set work item state (e.g. Active, Done, Closed, Removed)',  usage: '/status <state>',     requiresArgs: true },
  { name: 'comment',   description: 'Post a comment to the active work item discussion thread',   usage: '/comment <text>',     requiresArgs: true },
  { name: 'pick',      description: 'Browse and select a work item from the tree to set as active context',  usage: '/pick',               requiresArgs: false },
  { name: 'assign',    description: 'Assign the active work item to a team member (name or email)',  usage: '/assign <person>',    requiresArgs: true },
  { name: 'clear',     description: 'Clear all chat messages and start fresh',                    usage: '/clear',              requiresArgs: false },
  { name: 'mode',      description: 'Switch tool mode: inline (ask), plan (read-only), act (auto-approve), or yolo (full autonomy)',  usage: '/mode [mode]',        requiresArgs: false },
  { name: 'undo',      description: 'Revert the last state change made to the active work item',  usage: '/undo',               requiresArgs: false },
  { name: 'help',      description: 'List all available slash commands with usage examples',      usage: '/help',               requiresArgs: false },
  { name: 'delegate',  description: 'Hand off the active task to an external agent (claude, codex, hermes, pi, gemini)',  usage: '/delegate [agent] <prompt>', requiresArgs: true },
  { name: 'generate-tasks', description: 'Generate child tasks for the active user story (review in editor before saving)', usage: '/generate-tasks', requiresArgs: false },
  { name: 'resume',    description: 'Switch to a previous chat session to continue where you left off',  usage: '/resume',             requiresArgs: false },
  { name: 'remember',  description: 'Store a preference or instruction the AI will remember across sessions',  usage: '/remember <text>',    requiresArgs: true },
  { name: 'forget',    description: 'Remove all saved notes and preferences',                     usage: '/forget',             requiresArgs: false },
  { name: 'new-project', description: 'Open the project creation wizard',                         usage: '/new-project',         requiresArgs: false },
  { name: 'skills',      description: 'Open the skill catalog to browse and manage AI skills',    usage: '/skills',              requiresArgs: false },
];

/**
 * Return slash commands matching a partial query string.
 * Matches against the command name — case-insensitive prefix match.
 *
 * @param query - The text after the leading `/` (e.g. "st" matches "status")
 * @returns Array of matching SlashCommand objects, ordered by SLASH_COMMANDS
 */
export function matchCommands(query: string): SlashCommand[] {
  const lower = query.toLowerCase();
  return SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(lower));
}

/**
 * Parse a raw user message into a structured slash command invocation.
 *
 * @param text - The full user message (e.g. "/status Done" or "/clear")
 * @returns Parsed result with command name and optional args, or null if
 *          the message is not a slash command.
 */
export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  // Split: "/command args..." → command = "command", args = "args..."
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const command = SLASH_COMMANDS.find(cmd => cmd.name === name);
  if (!command) return null;

  // Validate: if the command requires args but none were provided, still
  // return it (the handler will decide what to do — maybe show usage).
  return { command, args };
}
