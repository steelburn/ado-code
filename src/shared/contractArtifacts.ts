/**
 * Contract-first artifacts for generated microservice repos.
 *
 * Why this module exists: the boilerplates shipped *type-level* contracts
 * (`packages/shared/src/contracts.ts`) but no machine-checkable artifact, so
 * nothing outside TypeScript could see a service's surface and no CI gate could
 * diff it. The ZEN handbook (§4.2 / CON-02) asks for a versioned OpenAPI 3.1
 * document and a versioned event envelope per published event, in `contracts/`,
 * so the contract — not the implementation — is the source of truth.
 *
 * Design notes:
 *  - Zero dependencies (repo convention): the YAML emitter below is a purpose
 *    built writer for the subset an OpenAPI document needs, not a general YAML
 *    library. It is deterministic: same input, byte-identical output.
 *  - Event JSON Schemas are self-contained on purpose. Cross-file `$ref` is
 *    legal but every naive validator and every editor plugin handles it
 *    differently; a self-contained schema validates with a single read.
 *    `envelope.v1.json` still exists and restates the same invariant, and a
 *    test asserts both required lists stay identical.
 *  - The runtime owns `/api/v1` (`API_PREFIX`) and the health path is imported
 *    from `containerHardening` so the Dockerfile HEALTHCHECK, the router and
 *    the contract cannot drift apart.
 */

import { HEALTHCHECK_PATH } from './containerHardening';

/** Mount point for every service router. Changing it is a breaking API change. */
export const API_PREFIX = '/api/v1';

/** Root folder that holds the machine-checkable contracts. */
export const CONTRACTS_DIR = 'contracts';

/** OpenAPI version emitted. 3.1 is the JSON-Schema-aligned revision. */
export const OPENAPI_VERSION = '3.1.0';

/** JSON Schema dialect used for event schemas. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Contract revision stamped into every path and schema id. */
export const CONTRACT_VERSION = 1;

/** Fields every event in the system carries, in this order. */
export const ENVELOPE_REQUIRED = [
  'eventId',
  'eventType',
  'timestamp',
  'source',
  'payload',
] as const;

/** Optional envelope fields — populated by the runtime, not by publishers. */
export const ENVELOPE_OPTIONAL = ['correlationId', 'version'] as const;

export interface ServiceContract {
  /** Service folder name, kebab-case (`orders-api`). */
  readonly name: string;
  /** Host port the service listens on. */
  readonly port: number;
  /** Collection the service exposes (`orders` → `/api/v1/orders`). */
  readonly resource: string;
  /** Event names this service publishes (`order.created`). */
  readonly events: readonly string[];
}

export interface ContractPlan {
  readonly projectName: string;
  readonly description?: string;
  readonly services: readonly ServiceContract[];
}

// ── path helpers ────────────────────────────────────────────────────────────

/** `contracts/openapi/orders-api.v1.yaml` */
export function openApiPath(service: string, version: number = CONTRACT_VERSION): string {
  return `${CONTRACTS_DIR}/openapi/${service}.v${version}.yaml`;
}

/** `contracts/events/order.created.v1.json` */
export function eventSchemaPath(eventName: string, version: number = CONTRACT_VERSION): string {
  return `${CONTRACTS_DIR}/events/${eventName}.v${version}.json`;
}

/** `contracts/events/envelope.v1.json` */
export function envelopeSchemaPath(version: number = CONTRACT_VERSION): string {
  return `${CONTRACTS_DIR}/events/envelope.v${version}.json`;
}

/** `contracts/README.md` */
export const CONTRACTS_README_PATH = `${CONTRACTS_DIR}/README.md`;

// ── naming helpers ──────────────────────────────────────────────────────────

const SERVICE_SUFFIXES = ['-api', '-service', '-svc', '-worker'];

/**
 * Collection name for a service folder: `orders-api` → `orders`,
 * `billing` → `billing`. No pluralisation is invented — a name that is already
 * a collection keeps its shape, which is the least surprising rule.
 */
export function resourceNameFor(serviceName: string): string {
  let base = serviceName;
  for (const suffix of SERVICE_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'resource';
}

/**
 * Crude, documented singularisation used only to build event names:
 * `orders` → `order`, `addresses` → `address`, `status` → `status`.
 * Deliberately not a full English inflector; a wrong guess yields a worse name
 * than a predictable one, and the team renames the event in the contract.
 */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/(ies)$/.test(word)) return `${word.slice(0, -3)}y`;
  // `addresses` → `address`, `boxes` → `box`: the stem already ends in a
  // sibilant, so only the `es` is the plural marker.
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is)$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Events a service publishes by default: created + updated for its resource. */
export function defaultEventsFor(serviceName: string): string[] {
  const subject = singularize(resourceNameFor(serviceName));
  return [`${subject}.created`, `${subject}.updated`];
}

/**
 * TypeScript-friendly key for an event name: `order.created` → `orderCreated`.
 * Used to generate the `eventNames` map so the code and the JSON Schemas in
 * `contracts/events/` cannot describe different events.
 */
export function eventKeyFor(eventName: string): string {
  const [head, ...rest] = eventName.split('.');
  return [head, ...rest.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)].join('');
}

function pascal(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
}

// ── zero-dependency YAML writer ─────────────────────────────────────────────

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

const SPECIAL_LEADING = /^[-?:,[\]{}#&*!|>'"%@`]/;
const NUMERIC_LIKE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const RESERVED_WORDS = /^(true|false|null|yes|no|on|off|~)$/i;

function isPlainSafe(value: string): boolean {
  if (value.length === 0) return false;
  if (SPECIAL_LEADING.test(value)) return false;
  if (/[{}[\],]/.test(value)) return false;
  if (/: |:$|#|\s$|^\s/.test(value)) return false;
  if (RESERVED_WORDS.test(value)) return false;
  if (NUMERIC_LIKE.test(value)) return false;
  return true;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function scalar(value: YamlValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return emptyLiteral(value);
  return isPlainSafe(value) ? value : quote(value);
}

function isComposite(value: YamlValue): boolean {
  return typeof value === 'object' && value !== null;
}

function isEmptyComposite(value: YamlValue): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

function emptyLiteral(value: YamlValue): string {
  return Array.isArray(value) ? '[]' : '{}';
}

function emitNode(value: YamlValue, indent: number, lines: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isComposite(item) && !isEmptyComposite(item)) {
        const nested: string[] = [];
        emitNode(item, indent + 2, nested);
        lines.push(`${pad}- ${nested[0].slice(indent + 2)}`);
        lines.push(...nested.slice(1));
      } else if (isComposite(item)) {
        lines.push(`${pad}- ${emptyLiteral(item)}`);
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }
  const map = value as { [key: string]: YamlValue };
  for (const [key, entry] of Object.entries(map)) {
    const renderedKey = isPlainSafe(key) ? key : quote(key);
    if (isComposite(entry) && !isEmptyComposite(entry)) {
      lines.push(`${pad}${renderedKey}:`);
      emitNode(entry, indent + 2, lines);
    } else if (isComposite(entry)) {
      lines.push(`${pad}${renderedKey}: ${emptyLiteral(entry)}`);
    } else {
      lines.push(`${pad}${renderedKey}: ${scalar(entry)}`);
    }
  }
}

/** Serialise a document to block-style YAML. Deterministic and dependency-free. */
export function toYaml(document: { [key: string]: YamlValue }): string {
  const lines: string[] = [];
  emitNode(document, 0, lines);
  return `${lines.join('\n')}\n`;
}

// ── OpenAPI document ────────────────────────────────────────────────────────

function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

const API_ERROR_SCHEMA: { [key: string]: YamlValue } = {
  type: 'object',
  description: 'Standard error body returned by every service.',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: { type: 'string', description: 'Human-readable message.' },
    code: { type: 'string', description: 'Stable machine-readable code.' },
    details: { description: 'Optional structured context.' },
  },
};

const HEALTH_SCHEMA: { [key: string]: YamlValue } = {
  type: 'object',
  description: `Health payload exposed at GET ${HEALTHCHECK_PATH}.`,
  required: ['status', 'service', 'version'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    service: { type: 'string' },
    version: { type: 'string' },
    uptimeSeconds: { type: 'number' },
    checks: {
      type: 'object',
      additionalProperties: { type: 'string', enum: ['up', 'down'] },
    },
  },
};

function resourceSchema(resource: string): { [key: string]: YamlValue } {
  const name = pascal(singularize(resource));
  return {
    type: 'object',
    description: `${name} as exposed by the service. Pin the real fields here first — this document is the source of truth, the code follows it.`,
    required: ['id'],
    additionalProperties: true,
    properties: {
      id: { type: 'string', format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function errorResponse(description: string): { [key: string]: YamlValue } {
  return {
    description,
    content: { 'application/json': { schema: ref('ApiError') } },
  };
}

function jsonContent(schema: { [key: string]: YamlValue } | { $ref: string }): {
  [key: string]: YamlValue;
} {
  return { 'application/json': { schema: schema as YamlValue } };
}

/**
 * Build one service's OpenAPI 3.1 document. Pure: no clock, no file system, no
 * randomness, so the emitted YAML is byte-stable across runs.
 */
export function buildOpenApiDocument(
  plan: ContractPlan,
  service: ServiceContract
): { [key: string]: YamlValue } {
  const item = pascal(singularize(service.resource));
  const collectionPath = `${API_PREFIX}/${service.resource}`;
  const itemPath = `${collectionPath}/{id}`;
  const tag = service.resource;

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: `${plan.projectName} — ${service.name}`,
      version: `${CONTRACT_VERSION}.0.0`,
      description:
        `Contract for ${service.name}.` +
        (plan.description ? ` ${plan.description}` : '') +
        ' Generated from the contract-first template: change this file before changing the implementation.',
    },
    servers: [
      { url: `http://localhost:${service.port}`, description: 'Local (docker compose)' },
    ],
    tags: [{ name: tag, description: `${item} endpoints` }],
    paths: {
      [collectionPath]: {
        get: {
          operationId: `list${pascal(service.resource)}`,
          summary: `List ${service.resource}`,
          tags: [tag],
          responses: {
            '200': {
              description: `${item} collection`,
              content: {
                'application/json': {
                  schema: { type: 'array', items: ref(item) },
                },
              },
            },
            '500': errorResponse('Unexpected server error'),
          },
        },
        post: {
          operationId: `create${item}`,
          summary: `Create ${singularize(service.resource)}`,
          tags: [tag],
          requestBody: {
            required: true,
            content: jsonContent(ref(item)),
          },
          responses: {
            '201': { description: 'Created', content: jsonContent(ref(item)) },
            '400': errorResponse('Invalid payload'),
          },
        },
      },
      [itemPath]: {
        get: {
          operationId: `get${item}`,
          summary: `Read one ${singularize(service.resource)}`,
          tags: [tag],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': { description: item, content: jsonContent(ref(item)) },
            '404': errorResponse('Not found'),
          },
        },
      },
      [HEALTHCHECK_PATH]: {
        get: {
          operationId: 'getHealth',
          summary: 'Liveness probe consumed by the Dockerfile HEALTHCHECK',
          tags: [tag],
          responses: {
            '200': { description: 'Service health', content: jsonContent(ref('HealthResponse')) },
          },
        },
      },
    },
    components: {
      schemas: {
        [item]: resourceSchema(service.resource),
        ApiError: API_ERROR_SCHEMA,
        HealthResponse: HEALTH_SCHEMA,
      },
    },
    ...(service.events.length > 0
      ? {
          'x-publishes': service.events.map((eventName) => ({
            event: eventName,
            schema: eventSchemaPath(eventName),
          })),
        }
      : {}),
  };
}

// ── event JSON Schemas ──────────────────────────────────────────────────────

function envelopeProperties(eventName?: string): { [key: string]: YamlValue } {
  return {
    eventId: { type: 'string', format: 'uuid' },
    eventType: eventName
      ? { const: eventName }
      : { type: 'string', description: 'Event name, e.g. order.created.' },
    timestamp: { type: 'string', format: 'date-time' },
    source: { type: 'string', description: 'Publishing service name.' },
    correlationId: { type: 'string', description: 'Propagated from the inbound request.' },
    version: { type: 'integer', const: CONTRACT_VERSION },
    payload: {
      type: 'object',
      description: 'Event-specific body. Pin its fields per event in this file.',
      additionalProperties: true,
    },
  };
}

/** The generic envelope every event travels in. */
export function buildEnvelopeSchema(): { [key: string]: unknown } {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `envelope.v${CONTRACT_VERSION}.json`,
    title: 'Event envelope',
    description:
      'Envelope every cross-service event travels in. Each event schema restates these fields and pins eventType with const.',
    type: 'object',
    required: [...ENVELOPE_REQUIRED],
    additionalProperties: false,
    properties: envelopeProperties(),
  };
}

/** One concrete, self-contained schema for a single event. */
export function buildEventSchema(eventName: string): { [key: string]: unknown } {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${eventName}.v${CONTRACT_VERSION}.json`,
    title: eventName,
    description: `Event ${eventName}, version ${CONTRACT_VERSION}. Published on the message broker; the payload is owned by the publishing service.`,
    type: 'object',
    required: [...ENVELOPE_REQUIRED],
    additionalProperties: false,
    properties: envelopeProperties(eventName),
  };
}

// ── the emitted file set ────────────────────────────────────────────────────

function contractsReadme(plan: ContractPlan): string {
  const rows = plan.services
    .map((service) => `| \`${service.name}\` | \`${openApiPath(service.name)}\` | ${service.events.map((e) => `\`${e}\``).join(', ') || '—'} |`)
    .join('\n');

  return `# Contracts — ${plan.projectName}

The contract is the source of truth. Change a document here **before** you change
the implementation; a pull request that changes a component, a route or an event
payload without touching this folder is incomplete.

## Layout

| Service | OpenAPI | Publishes |
|---|---|---|
${rows}

- \`openapi/\` — one OpenAPI ${OPENAPI_VERSION} document per service, versioned in the file name (\`.v${CONTRACT_VERSION}.yaml\`).
- \`events/\` — \`envelope.v${CONTRACT_VERSION}.json\` plus one JSON Schema (draft 2020-12) per event. Schemas are self-contained: each restates the envelope and pins \`eventType\`.

Every service router is mounted under \`${API_PREFIX}\`, so a route described here as
\`${API_PREFIX}/${plan.services[0]?.resource ?? 'orders'}\` is reachable at exactly that path.
\`${HEALTHCHECK_PATH}\` is the only path outside the prefix — the Dockerfile
\`HEALTHCHECK\` and the orchestrator probes depend on it.

## Rules

1. **Additive changes only within a version.** Adding an optional field is fine;
   removing or retyping one requires a new version (\`.v${CONTRACT_VERSION + 1}\`) and a migration note.
2. **Events are facts in the past tense.** \`order.created\`, not \`createOrder\`.
   Consumers ignore unknown fields, so new optional payload fields are safe.
3. **Never publish a payload you have not described here.** The envelope's
   \`eventId\` is the deduplication key for at-least-once delivery.
4. **Lint before you push** — the CI contract gate runs:

\`\`\`bash
npx @redocly/cli lint openapi/*.v${CONTRACT_VERSION}.yaml
\`\`\`

## Generated

These files are emitted by the project template. They are meant to be edited —
that is the point of contract-first — but keep the version in the file name in
step with the version in the document.
`;
}

/**
 * Every contract file for a plan, as `path → content`. The caller merges this
 * into its tree; nothing here touches the file system.
 */
export function planContractFiles(plan: ContractPlan): Record<string, string> {
  const files: Record<string, string> = {
    [CONTRACTS_README_PATH]: contractsReadme(plan),
    [envelopeSchemaPath()]: `${JSON.stringify(buildEnvelopeSchema(), null, 2)}\n`,
  };

  const eventNames = new Set<string>();
  for (const service of plan.services) {
    files[openApiPath(service.name)] = toYaml(buildOpenApiDocument(plan, service));
    for (const eventName of service.events) {
      eventNames.add(eventName);
    }
  }

  for (const eventName of [...eventNames].sort()) {
    files[eventSchemaPath(eventName)] = `${JSON.stringify(buildEventSchema(eventName), null, 2)}\n`;
  }

  return files;
}
