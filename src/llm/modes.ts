/**
 * Mode configuration system — defines AI assistant modes with tool filtering.
 *
 * Simplified from Roo-Code's complex modes system. Pure TypeScript, no VS Code dependency.
 */

import type { ToolGroup } from './tools/types';
import { TOOL_GROUP_MAP } from './tools/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a single assistant mode. */
export interface ModeConfig {
  /** URL-safe identifier (e.g. 'code', 'ask'). */
  slug: string;
  /** Display name shown in the UI. */
  name: string;
  /** One-line role description used in the system prompt. */
  role: string;
  /** Which tool groups this mode has access to. */
  toolGroups: ToolGroup[];
  /** Optional custom instructions appended to the system prompt. */
  customInstructions?: string;
  /** True when the mode was created by the user, not shipped as a default. */
  isCustom?: boolean;
}

// ---------------------------------------------------------------------------
// Tool-group → tool-name mapping
// ---------------------------------------------------------------------------

/**
 * Maps each logical tool group to the concrete tool names it contains.
 * Single source of truth — re-exports `TOOL_GROUP_MAP` from `tools/types.ts`
 * so mode gating and tool execution always agree on the group membership.
 */
export const TOOL_GROUPS = TOOL_GROUP_MAP;

// ---------------------------------------------------------------------------
// Default modes
// ---------------------------------------------------------------------------

export const DEFAULT_MODES: ModeConfig[] = [
  { slug: 'inline', name: 'Inline', role: 'Direct code edits with consent', toolGroups: ['read', 'write', 'execute'] },
  { slug: 'plan', name: 'Plan', role: 'Read-only planning, no edits', toolGroups: ['read'] },
  { slug: 'act', name: 'Act', role: 'Full auto-approve mode', toolGroups: ['read', 'write', 'execute'] },
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Find a mode by slug, checking custom modes first, then built-in defaults. */
export function getModeBySlug(
  slug: string,
  customModes?: ModeConfig[],
): ModeConfig | undefined {
  return (
    customModes?.find((m) => m.slug === slug) ??
    DEFAULT_MODES.find((m) => m.slug === slug)
  );
}

/** Return all available modes (defaults merged with any custom overrides). */
export function getAllModes(customModes?: ModeConfig[]): ModeConfig[] {
  if (!customModes?.length) {
    return [...DEFAULT_MODES];
  }

  const all = [...DEFAULT_MODES];

  for (const cm of customModes) {
    const idx = all.findIndex((m) => m.slug === cm.slug);
    if (idx !== -1) {
      all[idx] = cm;
    } else {
      all.push(cm);
    }
  }

  return all;
}

/**
 * Resolve the concrete tool names allowed in a given mode.
 *
 * Iterates over the mode's `toolGroups` and collects every tool name
 * from `TOOL_GROUPS`. The result is deduplicated.
 */
export function getToolsForMode(mode: ModeConfig): string[] {
  const tools = new Set<string>();
  for (const group of mode.toolGroups) {
    for (const tool of TOOL_GROUPS[group]) {
      tools.add(tool);
    }
  }
  return Array.from(tools);
}

/** Convenience alias — returns the first (default) mode. */
export function getDefaultMode(): ModeConfig {
  return DEFAULT_MODES[0];
}
