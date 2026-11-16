/**
 * The one scaffold context every writer reads.
 *
 * Today the scaffolder is keyed by `templateId` alone, `writeGitignore` keeps a
 * third ad-hoc id space of its own, and `planForTemplate` receives the options
 * but cannot see an architecture (docs/project-scaffolding.md §2.1, F2/F5).
 * Threading this context instead is what makes an architecture a first-class
 * value for the layout writers, the ignore-file writers and the dependency
 * planner without adding one dispatch case per stack per concern.
 *
 * Pure module: no fs, no vscode — the host and the webview both import it, like
 * `src/shared/projectDependencies.ts`.
 */

import { ArchitectureStyle, ScaffoldStack } from './architectureStyles';

/** Whether the user is allowed to turn Docker off for this architecture. */
export type ContainerizationRequirement = 'required' | 'optional';

/**
 * The containerization decision for one project. Produced only by
 * `resolveContainerization()`; consumers never re-derive it.
 */
export interface ContainerizationPolicy {
  /**
   * `required` → a Dockerfile is written no matter what the wizard's `docker`
   * option said (a conflicting answer is dropped with a warning, never an
   * error). `optional` → the option, or the architecture's default, decides.
   */
  docker: ContainerizationRequirement;
  /**
   * The effective Docker decision for this request — the one to act on.
   * `docker: 'required'` cannot express the deprecated template that keeps its
   * own flag authoritative, so the resolved answer travels beside the rule.
   */
  dockerEnabled: boolean;
  /** The effective Compose decision: write `docker-compose.yml` this run. */
  compose: boolean;
}

export type CiProvider = 'none' | 'github' | 'azure';

/**
 * Everything a scaffold writer needs that is not the request itself.
 *
 * `testAutomation` is intentionally absent: it belongs to the independent
 * test-automation track (docs/test-automation.md) and lands with it, so no
 * placeholder type is invented here.
 */
export interface ScaffoldContext {
  templateId: string;
  stack: ScaffoldStack;
  architecture: ArchitectureStyle;
  containerization: ContainerizationPolicy;
  ci: CiProvider;
}

export interface ContainerizationRequest {
  architecture: ArchitectureStyle;
  /** The wizard's own `docker` answer, when the template exposes one. */
  docker?: boolean;
  /** The project declares a database of its own. */
  database?: boolean;
  /** The project declares a message broker. */
  broker?: boolean;
  /**
   * Transitional escape hatch for the deprecated `monorepo-microservices`
   * template: it predates the architecture rule and still owns its `docker`
   * flag, so the user's answer stays authoritative instead of being forced on.
   * Without this, retiring the template would silently change trees that
   * already exist. Never set it for a new template.
   */
  honourDockerOption?: boolean;
}

export interface ContainerizationDecision {
  /** The decision for `ScaffoldContext.containerization`. */
  policy: ContainerizationPolicy;
  /** Warnings the create step must show (a dropped `docker: false`, …). */
  warnings: string[];
}

/**
 * The ONLY authority for "does this project get Docker / Compose?".
 *
 * §4.2 of docs/project-scaffolding.md states the rule in one line: *Compose is
 * required as soon as the project has more than one runtime process.*
 *
 * | Architecture      | Docker                      | Compose                                  |
 * | ----------------- | --------------------------- | ---------------------------------------- |
 * | `layered`         | unchanged: the option decides | none                                    |
 * | `modular-monolith`| on unless the user opts out | off until a DB/broker is declared, then required |
 * | `microservices`   | required                    | required                                 |
 *
 * Docker stays a soft prerequisite everywhere: a missing daemon produces a
 * warning and a validation step, never a failed create — wizards run on
 * machines that are not dev boxes.
 */
export function resolveContainerization(request: ContainerizationRequest): ContainerizationDecision {
  switch (request.architecture) {
    case 'microservices': {
      // Deprecated template: the user's flag is the answer (see the field doc).
      if (request.honourDockerOption) {
        const enabled = request.docker !== false;
        return {
          policy: { docker: 'optional', dockerEnabled: enabled, compose: enabled },
          warnings: [],
        };
      }
      const warnings =
        request.docker === false
          ? ['A microservices project always gets Docker and Docker Compose: the "docker" option was ignored.']
          : [];
      return {
        policy: { docker: 'required', dockerEnabled: true, compose: true },
        warnings,
      };
    }

    case 'modular-monolith': {
      // One deployable can run bare, so opting out of Docker is allowed — until
      // the project declares a DB or a broker, which is exactly when the second
      // runtime process (and therefore Compose) appears.
      const compose = request.database === true || request.broker === true;
      const optedOut = request.docker === false;
      if (compose && optedOut) {
        return {
          policy: { docker: 'required', dockerEnabled: true, compose: true },
          warnings: [
            'Declaring a database or a broker makes Docker Compose required, so the "docker" option was ignored.',
          ],
        };
      }
      return {
        policy: { docker: 'optional', dockerEnabled: !optedOut, compose },
        warnings: [],
      };
    }

    case 'layered':
    default:
      // Byte-for-byte today's behaviour: a template that had a Dockerfile option
      // still honours it, and nothing gains a compose file.
      return {
        policy: { docker: 'optional', dockerEnabled: request.docker === true, compose: false },
        warnings: [],
      };
  }
}
