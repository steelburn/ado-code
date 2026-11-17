/**
 * The delivery tree — which files `planDeliveryFiles` puts in a scaffold.
 *
 * Kept apart from `deliveryArtifacts` (which renders one artifact each) so the
 * stack planners can merge a single map into their own tree, and so a project
 * either gets all of the delivery envelope or none of it.
 */

import {
  planCiWorkflow,
  planDatabaseOverlay,
  planK8sManifests,
  planK8sReadme,
  runtimeFamily,
  type RuntimeFamily,
} from './deliveryArtifacts';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const COMPOSE_DATABASE_PATH = 'docker-compose.databases.yml';
export const EVENT_SCHEMA_VALIDATOR_PATH = 'scripts/validate-event-schemas.mjs';
export const CONTRACTS_DIR = 'contracts';

/**
 * Gate 3 checks the event schemas. A shell one-liner would need three levels of
 * quoting inside a workflow, so the check is a committed script instead — and a
 * developer can run exactly what CI runs.
 */
export const EVENT_SCHEMA_VALIDATOR = `#!/usr/bin/env node
// Validates contracts/events/*.json: valid JSON, and every schema still declares
// the envelope fields the services actually publish. Zero dependencies.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '${CONTRACTS_DIR}/events';
const ENVELOPE_FIELDS = ['eventId', 'eventType', 'timestamp', 'source', 'version', 'payload'];

let failures = 0;
for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    console.error(\`\${file}: not valid JSON — \${error.message}\`);
    failures += 1;
    continue;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = ENVELOPE_FIELDS.filter((field) => !required.includes(field));
  if (missing.length > 0) {
    console.error(\`\${file}: envelope is missing \${missing.join(', ')}\`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(\`\${failures} event schema(s) failed validation\`);
  process.exit(1);
}
console.log('event schemas ok');
`;

/** One service's Kubernetes shape. */
export interface DeliveryService {
  readonly name: string;
  readonly port: number;
  readonly kind: 'api' | 'worker';
  /** Non-secret environment rendered into the ConfigMap. */
  readonly env?: readonly { readonly name: string; readonly value: string }[];
}

export interface DeliveryTreePlan {
  /** npm scope / org — the image namespace. */
  readonly scope: string;
  readonly version: string;
  /** Catalogue stack id; only its runtime family matters here. */
  readonly stack: string;
  /** Every service the image matrix builds, gateway included. */
  readonly services: readonly DeliveryService[];
  readonly k8s: boolean;
  /** Emit the contract gates. */
  readonly contracts: boolean;
  /** Emit the per-service database overlay (only meaningful with compose). */
  readonly compose?: boolean;
}

/** Delivery files keyed by workspace-relative path. */
export function planDeliveryFiles(plan: DeliveryTreePlan): Record<string, string> {
  const family: RuntimeFamily = runtimeFamily(plan.stack);
  const names = plan.services.map((service) => service.name);
  const files: Record<string, string> = {};

  files[CI_WORKFLOW_PATH] = planCiWorkflow({
    family,
    services: names,
    k8s: plan.k8s,
    contractsDir: plan.contracts ? CONTRACTS_DIR : undefined,
  });

  if (plan.contracts) {
    files[EVENT_SCHEMA_VALIDATOR_PATH] = EVENT_SCHEMA_VALIDATOR;
  }

  // The gateway owns no store, so it is excluded from the database overlay.
  const domainServices = plan.services
    .filter((service) => service.name !== 'gateway')
    .map((service) => service.name);
  if (domainServices.length > 0 && plan.compose !== false) {
    files[COMPOSE_DATABASE_PATH] = planDatabaseOverlay({ services: domainServices });
  }

  if (!plan.k8s) {
    return files;
  }

  for (const service of plan.services) {
    files[`deploy/k8s/${service.name}.yaml`] = planK8sManifests({
      service: service.name,
      scope: plan.scope,
      port: service.port,
      version: plan.version,
      kind: service.kind,
      family,
      env: service.env ?? [
        { name: 'PORT', value: String(service.port) },
        { name: 'LOG_LEVEL', value: 'info' },
      ],
      secretKeys: ['DATABASE_URL'],
    });
  }

  files['deploy/k8s/README.md'] = planK8sReadme({ scope: plan.scope });
  return files;}
