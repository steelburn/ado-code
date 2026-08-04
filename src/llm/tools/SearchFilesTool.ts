/**
 * SearchFilesTool - Search file contents with regex patterns.
 *
 * Adapted from Roo-Code's SearchFilesTool, simplified for our project.
 * Searches for regex matches in file contents, returning filepath:line_number:matching_line.
 */

import * as path from 'path';
import { createReadStream, type Stats } from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';

import { BaseTool } from './BaseTool';
import type { TaskLike, ToolCallbacks } from './BaseTool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchFilesParams {
  /** Directory or file to search in (relative to cwd) */
  path: string;
  /** Regex pattern to search for */
  regex: string;
  /** Optional glob pattern to filter files (e.g. '*.ts') */
  file_pattern?: string | null;
  /** Maximum number of results to return (default: 250) */
  limit?: number;
}

interface SearchResult {
  file: string;
  line: number;
  match: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a file matches a glob-like pattern.
 * Supports simple patterns like "*.ts", "*.test.ts", "src/[GLOBSTAR][GLOBSTAR]/.ts"
 * For simplicity, we handle basic glob matching using regex conversion.
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  if (!pattern) return true;

  // Convert glob pattern to regex
  // Handle ** (match any directories)
  let regexStr = pattern
    .replace(/\./g, '\\.') // escape dots
    .replace(/\*\*/g, '{{GLOBSTAR}}') // placeholder for **
    .replace(/\*/g, '[^/]*') // single * matches anything except /
    .replace(/\?/g, '[^/]') // ? matches single char
    .replace(/\{\{GLOBSTAR\}\}/g, '.*'); // ** matches anything

  // Ensure full match
  regexStr = `^${regexStr}$`;

  try {
    const regex = new RegExp(regexStr);
    return regex.test(filePath);
  } catch {
    // If regex is invalid, fall back to simple string match
    return filePath.includes(pattern.replace(/\*/g, ''));
  }
}

/**
 * Get files to search recursively.
 * Returns an array of file paths relative to the base directory.
 */
async function getFiles(
  dir: string,
  baseDir: string,
  filePattern: string | undefined,
): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath);

      // Skip node_modules, .git, and other hidden directories
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) {
          continue;
        }
        const subFiles = await getFiles(fullPath, baseDir, filePattern);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        if (!filePattern || matchesGlob(relPath, filePattern)) {
          files.push(relPath);
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return files;
}

/**
 * Search a single file for regex matches.
 * Returns matches in format: filepath:line_number:matching_line
 */
async function searchFile(
  fileRelPath: string,
  fileAbsolutePath: string,
  regex: RegExp,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  try {
    const fileStream = createReadStream(fileAbsolutePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;
      if (regex.test(line)) {
        results.push({
          file: fileRelPath,
          line: lineNum,
          match: line.trimEnd(),
        });
      }
    }
  } catch {
    // File can't be read (binary, permissions, etc.) - skip silently
  }

  return results;
}

/**
 * Format results as filepath:line_number:matching_line
 */
function formatResults(results: SearchResult[]): string {
  return results
    .map((r) => `${r.file}:${r.line}: ${r.match}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// SearchFilesTool
// ---------------------------------------------------------------------------

export class SearchFilesTool extends BaseTool {
  readonly name = 'search_files' as const;

  async execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    try {
      const { path: relDirPath, regex: regexStr, file_pattern, limit: rawLimit } = params as unknown as SearchFilesParams;
      const maxResults = (typeof rawLimit === 'number' && rawLimit > 0) ? rawLimit : 250;

      // Validate required params
      if (!relDirPath) {
        callbacks.pushToolResult(callbacks.toolCallId, 'Error: Missing required parameter "path".');
        return;
      }

      if (!regexStr) {
        callbacks.pushToolResult(callbacks.toolCallId, 'Error: Missing required parameter "regex".');
        return;
      }

      // Compile regex
      let regex: RegExp;
      try {
        regex = new RegExp(regexStr, 'i');
      } catch {
        callbacks.pushToolResult(
          callbacks.toolCallId,
          `Error: Invalid regex pattern "${regexStr}".`,
        );
        return;
      }

      const absolutePath = path.resolve(task.cwd, relDirPath);

      // Workspace boundary validation
      const resolvedCwd = path.resolve(task.cwd)
      const resolvedAbsolute = path.resolve(absolutePath)
      if (!resolvedAbsolute.startsWith(resolvedCwd + path.sep) && resolvedAbsolute !== resolvedCwd) {
        callbacks.pushToolResult(callbacks.toolCallId, `Error: Path '${relDirPath}' resolves outside the workspace.`);
        return;
      }

      const filePattern = file_pattern || undefined;

      await task.say(`Searching for "${regexStr}" in ${relDirPath}${filePattern ? ` (pattern: ${filePattern})` : ''}...`);

      const results: SearchResult[] = [];

      // Check if path is a file or directory
      let stat: Stats;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        callbacks.pushToolResult(
          callbacks.toolCallId,
          `Error: Path "${relDirPath}" does not exist or is not accessible.`,
        );
        return;
      }

      if (stat.isFile()) {
        // Search single file
        const fileResults = await searchFile(relDirPath, absolutePath, regex);
        results.push(...fileResults);
      } else if (stat.isDirectory()) {
        // Search directory recursively
        const files = await getFiles(absolutePath, absolutePath, filePattern);

        for (const file of files) {
          const fileAbsolutePath = path.join(absolutePath, file);
          const fileResults = await searchFile(file, fileAbsolutePath, regex);
          results.push(...fileResults);

          // Stop if we have enough results
          if (results.length >= maxResults) {
            break;
          }
        }
      }

      if (results.length === 0) {
        callbacks.pushToolResult(
          callbacks.toolCallId,
          `No matches found for "${regexStr}" in ${relDirPath}.`,
        );
      } else {
        const formatted = formatResults(results.slice(0, maxResults));
        const totalMatches = results.length;
        const output =
          totalMatches > maxResults
            ? `${formatted}\n\n(Showing ${maxResults} of ${totalMatches} matches. Try narrowing your search with file_pattern or a more specific path.)`
            : formatted;

        callbacks.pushToolResult(callbacks.toolCallId, output);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Error in search_files:`, errMsg);
      callbacks.pushToolResult(callbacks.toolCallId, `Error searching files: ${errMsg}`);
    } finally {
      this.resetPartialState();
    }
  }
}

export const searchFilesTool = new SearchFilesTool();
