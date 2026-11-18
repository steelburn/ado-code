/**
 * Named wizard presets — the shortcut that makes a compliant scaffold the default.
 *
 * Why this module exists: the handbook's §4.4 offers two free-text prompts ("build
 * me a production-ready microservice"), which is exactly the failure mode the
 * deterministic wizard replaced — an agent hand-writes files from memory and the
 * artifacts the standard depends on are the first thing it forgets. A preset is the
 * same intent expressed as option values the tested planners consume, so the
 * standard cannot be skipped by choosing the friendlier prompt.
 *
 * Mirrors `architectureStyles.ts` and `monorepoStacks.ts`: pure data + pure
 * functions, no `fs`, no `vscode`, so the wizard renders it and the host resolves
 * it from the same table.
 */

import {
  MONOREPO_STACKS,
  STACK_OPTION_ID,
  isMonorepoStackId,
  type MonorepoStackId,
} from './monorepoStacks';
import { CLAUSE_IDS } from './standardsArtifacts';

/** The template the microservice presets target. */
export const MONOREPO_TEMPLATE_ID = 'monorepo-microservices';

/** The preset the wizard selects by default — a ZEN microservice monorepo. */
export const DEFAULT_PRESET_ID = 'zen-microservices';

/**
 * The monorepo template's option ids, as the wizard declares them and the host
 * reads them. `resolvePreset` validates against this set, so a typo in a preset
 * fails a test instead of being silently ignored at scaffold time.
 */
export const PRESET_OPTION_IDS = {
  stack: STACK_OPTION_ID,
  services: 'services',
  sharedPackage: 'sharedPackage',
  messageBroker: 'messageBroker',
  docker: 'docker',
  k8s: 'k8s',
  ci: 'ci',
} as const;

export type PresetOptionId = (typeof PRESET_OPTION_IDS)[keyof typeof PRESET_OPTION_IDS];

export interface WizardPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Catalogue template the preset selects. */
  readonly templateId: string;
  readonly options: Readonly<Record<PresetOptionId, string | boolean>>;
  /**
   * Clause ids the preset is expected to leave satisfied — asserted against the
   * emitted tree in `wizardPresets.test.ts`. Clauses the scaffold does not yet
   * enforce (`CON-06` outside the node stack) are absent on
   * purpose: a preset that claims them would be advertising a guarantee it cannot
   * keep.
   */
  readonly satisfies: readonly string[];
}

/** The services every preset scaffolds: one gateway plus two domain services. */
const DEFAULT_SERVICES = 'gateway,users,orders';

/**
 * Runtime clauses every stack satisfies, plus the ones the node stack closes on
 * top (`CON-06` needs `packages/shared/src/resilience.ts`, which only the
 * TypeScript stack emits). `CON-05` is shared: the node stack validates the JWT in
 * `packages/shared/src/auth.ts`, the other three re-verify the edge stamp with
 * their own standard library (`securityEdgeGuards.ts`).
 */
function satisfiedClauses(stack: MonorepoStackId): readonly string[] {
  const shared: readonly string[] = [
    CLAUSE_IDS.container,
    CLAUSE_IDS.contract,
    CLAUSE_IDS.observability,
    CLAUSE_IDS.lifecycle,
    CLAUSE_IDS.security,
  ];
  const resilience = stack === 'node-ts' ? [CLAUSE_IDS.resilience] : [];
  const gates: readonly string[] = [
    CLAUSE_IDS.ciStatic,
    CLAUSE_IDS.ciTest,
    CLAUSE_IDS.ciBuild,
    CLAUSE_IDS.ciImage,
    CLAUSE_IDS.ciDeploy,
    CLAUSE_IDS.ciDatabase,
    CLAUSE_IDS.ciK8s,
  ];
  return [...shared, ...resilience, ...gates];
}

function microservicePreset(stack: MonorepoStackId): WizardPreset {
  const label = MONOREPO_STACKS.find((entry) => entry.id === stack)?.label ?? stack;
  return {
    id: stack === 'node-ts' ? DEFAULT_PRESET_ID : `${DEFAULT_PRESET_ID}-${stack}`,
    label: `ZEN microservices · ${label}`,
    description:
      'Monorepo, contract-first services, hardened containers, observability, CI gates — the standard, in one click.',
    templateId: MONOREPO_TEMPLATE_ID,
    options: {
      stack,
      services: DEFAULT_SERVICES,
      sharedPackage: true,
      messageBroker: 'rabbitmq',
      docker: true,
      k8s: true,
      ci: true,
    },
    satisfies: satisfiedClauses(stack),
  };
}

/** One preset per catalogue stack — `zen-microservices` is the node-ts one. */
export const WIZARD_PRESETS: readonly WizardPreset[] = MONOREPO_STACKS.map((stack) =>
  microservicePreset(stack.id)
);

export function isWizardPresetId(id: unknown): id is string {
  return typeof id === 'string' && WIZARD_PRESETS.some((preset) => preset.id === id);
}

/**
 * The preset behind an id. Throws rather than falling back: silently scaffolding
 * a different preset than the one asked for is how a team ends up with a tree
 * nobody chose.
 */
export function wizardPreset(id: string): WizardPreset {
  const found = WIZARD_PRESETS.find((preset) => preset.id === id);
  if (!found) {
    throw new Error(`Unknown wizard preset: ${id}`);
  }
  return found;
}

export interface ResolvedPreset {
  readonly templateId: string;
  readonly options: Record<string, string | boolean>;
  readonly preset: WizardPreset;
}

/**
 * Turn a preset id into the request the scaffolders take.
 *
 * Overrides are allowed (a team wants the standard *with* a different stack) but
 * validated: an unknown option id or a non-catalogue stack throws, because both
 * would otherwise be dropped by the host and produce a tree that quietly does not
 * match the preset.
 */
export function resolvePreset(
  id: string,
  overrides: Partial<Record<PresetOptionId, string | boolean>> = {}
): ResolvedPreset {
  const preset = wizardPreset(id);
  const options: Record<string, string | boolean> = { ...preset.options };

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in PRESET_OPTION_IDS)) {
      throw new Error(`Unknown preset option: ${key}`);
    }
    if (key === PRESET_OPTION_IDS.stack && !isMonorepoStackId(value)) {
      throw new Error(`Unknown monorepo stack: ${String(value)}`);
    }
    options[key] = value;
  }

  return { templateId: preset.templateId, options, preset };
}
