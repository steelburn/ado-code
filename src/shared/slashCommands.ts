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
  { name: 'status',    description: 'Change work item state',        usage: '/status <state>',     requiresArgs: true },
  { name: 'comment',   description: 'Add comment to work item',     usage: '/comment <text>',     requiresArgs: true },
  { name: 'pick',      description: 'Pick a work item',             usage: '/pick',               requiresArgs: false },
  { name: 'assign',    description: 'Assign work item',             usage: '/assign <person>',    requiresArgs: true },
  { name: 'clear',     description: 'Clear chat history',           usage: '/clear',              requiresArgs: false },
  { name: 'mode',      description: 'Switch mode (chat/plan/act)',  usage: '/mode [mode]',        requiresArgs: false },
  { name: 'undo',      description: 'Undo last state change',       usage: '/undo',               requiresArgs: false },
  { name: 'help',      description: 'Show available commands',      usage: '/help',               requiresArgs: false },
  { name: 'delegate',  description: 'Delegate to an agent',         usage: '/delegate [agent] <prompt>', requiresArgs: true },
  { name: 'resume',    description: 'Resume a previous session',    usage: '/resume',             requiresArgs: false },
  { name: 'remember',  description: 'Save a note for context',      usage: '/remember <text>',    requiresArgs: true },
  { name: 'forget',    description: 'Clear saved notes',            usage: '/forget',             requiresArgs: false },
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
