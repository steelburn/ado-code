/**
 * SkillManager — manages skill lifecycle (load, list, execute).
 *
 * Provides:
 * - Loading built-in and user-installed skills
 * - Listing available skills
 * - Executing skills by ID with input context
 *
 * Skills are defined in src/shared/skillTypes.ts.
 */

import * as vscode from 'vscode';
import {
  type Skill,
  type SkillExecutionRequest,
  type SkillExecutionResult,
  BUILTIN_SKILLS,
} from '../shared/skillTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Skills configuration persisted in VS Code globalState. */
interface SkillsState {
  /** User-installed skill IDs (beyond built-in). */
  installedIds: string[];
  /** Disabled skill IDs (built-in or installed). */
  disabledIds: string[];
}

// ---------------------------------------------------------------------------
// SkillManager
// ---------------------------------------------------------------------------

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private state: SkillsState;
  private static readonly STATE_KEY = 'adoCode.skillsState';

  constructor(private context: vscode.ExtensionContext) {
    // Restore persisted state or default
    this.state = context.globalState.get<SkillsState>(
      SkillManager.STATE_KEY,
      { installedIds: [], disabledIds: [] },
    );

    // Load built-in skills
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, { ...skill });
    }

    // Apply persisted enabled/disabled state
    for (const skill of this.skills.values()) {
      if (this.state.disabledIds.includes(skill.id)) {
        skill.enabled = false;
      } else {
        skill.enabled = true;
      }
    }
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  /** Return all loaded skills (built-in + installed). */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** Return only enabled skills. */
  getEnabledSkills(): Skill[] {
    return this.getAllSkills().filter((s) => s.enabled);
  }

  /** Look up a single skill by ID. */
  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Install a user skill. Returns false if it already exists. */
  installSkill(skill: Skill): boolean {
    if (this.skills.has(skill.id)) {
      return false;
    }
    this.skills.set(skill.id, { ...skill, installed: true, enabled: true });
    this.persistState();
    return true;
  }

  /** Uninstall a non-builtin skill. Returns false for builtin or missing. */
  uninstallSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill || skill.builtin) {
      return false;
    }
    this.skills.delete(id);
    this.persistState();
    return true;
  }

  /** Enable a skill by ID. Returns false if not found. */
  enableSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;
    skill.enabled = true;
    this.state.disabledIds = this.state.disabledIds.filter((d) => d !== id);
    this.persistState();
    return true;
  }

  /** Disable a skill by ID. Returns false if not found. */
  disableSkill(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;
    skill.enabled = false;
    if (!this.state.disabledIds.includes(id)) {
      this.state.disabledIds.push(id);
    }
    this.persistState();
    return true;
  }

  /** Toggle a skill's enabled state. Persists to globalState. */
  async toggleSkill(id: string): Promise<boolean> {
    const skill = this.skills.get(id);
    if (!skill) {
      return false;
    }

    skill.enabled = !skill.enabled;

    if (!skill.enabled) {
      if (!this.state.disabledIds.includes(id)) {
        this.state.disabledIds.push(id);
      }
    } else {
      this.state.disabledIds = this.state.disabledIds.filter((d) => d !== id);
    }

    await this.persistState();
    return skill.enabled;
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /**
   * Execute a skill by ID with the given input.
   *
   * For prompt-based skills, the skill's prompt template is combined with
   * the input and returned as output (the LLM will process it).
   * For tool-chain skills, each step would be executed sequentially.
   */
  async executeSkill(
    request: SkillExecutionRequest,
  ): Promise<SkillExecutionResult> {
    const skill = this.skills.get(request.skillId);

    if (!skill) {
      return {
        success: false,
        output: '',
        error: `Skill '${request.skillId}' not found. Available skills: ${this.getEnabledSkills().map((s) => s.id).join(', ')}`,
      };
    }

    if (!skill.enabled) {
      return {
        success: false,
        output: '',
        error: `Skill '${skill.name}' is disabled. Enable it first.`,
      };
    }

    // Build the output from the skill's prompt template + input
    let output = '';

    if (skill.prompt) {
      // Prompt-based skill: combine prompt template with user input
      output = `${skill.prompt}\n\n---\n\n**Input:**\n${request.input}`;
    } else if (skill.toolChain && skill.toolChain.length > 0) {
      // Tool-chain skill: return the chain for the LLM to execute
      output = JSON.stringify({
        message: `Tool chain skill '${skill.name}' requires sequential execution. The following tools should be invoked:`,
        toolChain: skill.toolChain,
      });
    } else if (skill.knowledge) {
      // Knowledge-based skill: combine knowledge with input
      output = `${skill.knowledge}\n\n---\n\n**Input:**\n${request.input}`;
    } else {
      return {
        success: false,
        output: '',
        error: `Skill '${skill.name}' has no prompt, toolChain, or knowledge content.`,
      };
    }

    return {
      success: true,
      output,
      toolCalls: [],
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private async persistState(): Promise<void> {
    await this.context.globalState.update(SkillManager.STATE_KEY, this.state);
  }
}
