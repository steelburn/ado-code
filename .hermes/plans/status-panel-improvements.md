# Status Panel Improvements — Future Work

## Context

The Status Panel (tree view) currently shows Mode, Memory, MCP, Agents, and Worktrees.
Basic context menus were added for Memory, Agents, and Worktrees. The following
improvements are candidates for future iterations.

---

## 1. MCP Server Management

**Priority:** High  
**Effort:** Small

Add right-click context menu on MCP server items:
- **Disconnect** — disconnect a specific server without restarting all
- **Reconnect** — reconnect a failed/disconnected server
- **View Details** — show server config (command, args, tools count)

Requires: `McpManager` methods to disconnect/reconnect individual servers
(currently only `disconnectAll` exists).

---

## 2. Mode Quick-Cycle

**Priority:** Medium  
**Effort:** Small

Right-click on the Mode item to cycle through modes directly:
- Cycle: inline → plan → act → inline
- Or show a sub-menu with all three options

Avoids the QuickPick dialog for a faster workflow.

---

## 3. Worktree Batch Cleanup

**Priority:** Medium  
**Effort:** Small

Add a "Remove All Completed" action on the Worktrees parent node:
- Lists worktrees whose agent runs have finished (succeeded/failed/cancelled)
- Confirmation dialog showing how many will be removed
- Skips worktrees with running agents

---

## 4. Agent Details Panel

**Priority:** Low  
**Effort:** Medium

"View Details" context action on agent items:
- Opens a webview panel (like WorkItemDetailPanel) showing:
  - Agent name, display name, version
  - Supported modes (one-shot, session)
  - CLI path (which was detected)
  - Configuration options

---

## 5. Memory Search/Filter

**Priority:** Low  
**Effort:** Small

When Memory section has many entries (>10):
- Show a search/filter input at the top of the Memory subtree
- Filter by key or content text
- client-side filter (no API calls)

---

## 6. Status Panel Keyboard Shortcuts

**Priority:** Low  
**Effort:** Small

Register keybindings for common Status Panel actions:
- `Ctrl+Shift+D` — Deselect Work Item
- `Ctrl+Shift+M` — Cycle Mode
- `Ctrl+Shift+R` — Refresh Status

---

## 7. Agent Run History

**Priority:** Medium  
**Effort:** Medium

Add a "Recent Runs" section to Status Panel:
- Show last N completed agent runs (from persisted store)
- Right-click to view summary, open worktree, or copy run ID
- Auto-cleanup after 7 days

---

## 8. Worktree Diff Viewer

**Priority:** Low  
**Effort:** Medium

Right-click on a worktree → "Show Changes":
- Opens a diff editor comparing worktree branch against main
- Uses VS Code's built-in diff viewer

---

## 9. Memory Import/Export

**Priority:** Low  
**Effort:** Small

Right-click on Memory parent node:
- **Export** — save all memories to a JSON file
- **Import** — load memories from a JSON file (merge or replace)

Useful for sharing preferences across machines or backing up.

---

## 10. Status Panel Configuration

**Priority:** Low  
**Effort:** Small

Right-click on Status Panel header:
- **Collapse All** — collapse all sections
- **Expand All** — expand all sections
- **Hide Section** — toggle visibility of sections (persisted in settings)

---

*Created: 2026-08-06*
*Last Updated: 2026-08-06*
