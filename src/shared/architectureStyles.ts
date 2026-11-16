/**
 * Architecture styles the New Project wizard can offer.
 *
 * Why this is worth a shared module: the webview renders the option, the host
 * scaffolds it, and `src/shared/projectDependencies.ts` has to plan for it —
 * three consumers that must agree on the ids. It mirrors
 * `src/shared/projectDependencies.ts`: pure data + pure helpers, no fs, no
 * vscode, so both the extension host and the webview bundle import it directly.
 *
 * The allow-list is deliberately small. A frontend or mobile template has one
 * deployable, so "modular monolith" there means route groups — a different
 * concept — and microservices would produce a monorepo around a single app.
 * Those templates keep their single layout.
 *
 * See `docs/project-scaffolding.md` §4.1 for the design this implements.
 */

import { TemplateOption } from '../webview-ui/src/components/ProjectCreationWizard/types';

/** How a project is decomposed. `layered` is today's output, unchanged. */
export type ArchitectureStyle = 'layered' | 'modular-monolith' | 'microservices';

/**
 * Runtime family a template scaffolds. The three .NET templates share one
 * stack: a service body does not care whether its host project is a web API,
 * a console app or a MAUI shell.
 */
export type ScaffoldStack = 'node-ts' | 'node-js' | 'python' | 'php-laravel' | 'dotnet';

export interface ArchitectureStyleInfo {
  id: ArchitectureStyle;
  label: string;
  description: string;
}

/** Ordered widest-to-narrowest; the wizard renders them in this order. */
export const ARCHITECTURE_STYLES: readonly ArchitectureStyleInfo[] = [
  {
    id: 'layered',
    label: 'Layered (single deployable)',
    description: 'One project, layered in place. The default, and exactly what the templates produce today.',
  },
  {
    id: 'modular-monolith',
    label: 'Modular monolith',
    description: 'One deployable split into modules with enforced import boundaries — extractable into services later.',
  },
  {
    id: 'microservices',
    label: 'Microservices',
    description: 'A monorepo of independently deployable services under services/, wired together by Docker Compose.',
  },
];

/** Option id under which the wizard stores the choice in `templateOptions`. */
export const ARCHITECTURE_OPTION_ID = 'architecture';

export function isArchitectureStyle(value: unknown): value is ArchitectureStyle {
  return ARCHITECTURE_STYLES.some((style) => style.id === value);
}

/**
 * The `TemplateOption` a server-capable template adds to its option list. One
 * function so the label, the choices and the default cannot drift between
 * templates — and so the drift test in §8 has a single definition to compare
 * against `supportsArchitecture()`.
 */
export function architectureOption(defaultStyle: ArchitectureStyle = 'layered'): TemplateOption {
  return {
    id: ARCHITECTURE_OPTION_ID,
    label: 'Architecture',
    type: 'select',
    default: defaultStyle,
    options: ARCHITECTURE_STYLES.map((style) => style.id),
    optionLabels: Object.fromEntries(ARCHITECTURE_STYLES.map((style) => [style.id, style.label])),
    description: 'Layered keeps the classic layout; the other two change the folder tree and how the project is deployed.',
  };
}

/** One template that may choose an architecture, and the stack it scaffolds. */
export interface ArchitectureCapability {
  templateId: string;
  stack: ScaffoldStack;
  architectures: readonly ArchitectureStyle[];
}

const ALL_ARCHITECTURES: readonly ArchitectureStyle[] = ['layered', 'modular-monolith', 'microservices'];

/**
 * The stack → architecture capability table. Everything not listed here has no
 * architecture choice: `react-ts`, `nextjs`, `react-native`, `flutter`,
 * `dotnet-maui`, `dotnet-console`, `empty` and every `doc-*` template.
 */
export const ARCHITECTURE_CAPABILITIES: readonly ArchitectureCapability[] = [
  { templateId: 'node-ts', stack: 'node-ts', architectures: ALL_ARCHITECTURES },
  { templateId: 'node-js', stack: 'node-js', architectures: ALL_ARCHITECTURES },
  { templateId: 'python', stack: 'python', architectures: ALL_ARCHITECTURES },
  { templateId: 'php-laravel', stack: 'php-laravel', architectures: ALL_ARCHITECTURES },
  { templateId: 'dotnet-webapi', stack: 'dotnet', architectures: ALL_ARCHITECTURES },
];

/** The capability entry for a template, if it has an architecture choice. */
export function architectureCapability(templateId: string): ArchitectureCapability | undefined {
  return ARCHITECTURE_CAPABILITIES.find((capability) => capability.templateId === templateId);
}

export function supportsArchitecture(templateId: string): boolean {
  return architectureCapability(templateId) !== undefined;
}

/** The stack a supported template scaffolds; `undefined` for every other id. */
export function stackForTemplate(templateId: string): ScaffoldStack | undefined {
  return architectureCapability(templateId)?.stack;
}

/**
 * The requested architecture. Anything unknown — no option (templates written
 * before this existed), a stale saved value, a hand-edited payload — resolves
 * to `layered`, which is the byte-identical legacy output.
 */
export function resolveArchitecture(options: Record<string, unknown> | undefined): ArchitectureStyle {
  const requested = options?.[ARCHITECTURE_OPTION_ID];
  return isArchitectureStyle(requested) ? requested : 'layered';
}
