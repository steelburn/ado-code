/**
 * Container hardening shared by every Dockerfile the wizard emits.
 *
 * Why one module: the ZEN handbook's CON‑01 clause — multi-stage build,
 * non-root `USER`, `HEALTHCHECK`, deterministic base-image pin — applies to
 * every containerizable stack, and the base images were re-typed in three
 * writers (`containerization.ts`, `monorepoStacks.ts`,
 * `ProjectCreationService.ts`). Centralising the pins and the hardening tail is
 * what lets the clause be met once instead of fourteen times, and it keeps
 * `node:20-alpine` from drifting in one Dockerfile and not another.
 *
 * The pins are full patch tags on purpose: `node:20-alpine` silently moves on
 * every rebuild, so two images built a month apart are not the same image. The
 * digest form (`node:20.18.0-alpine3.20@sha256:…`) is the fully reproducible
 * one and belongs to the release pipeline, not to a scaffold that would then
 * freeze on a stale base.
 *
 * Health probe path: `HEALTHCHECK_PATH` is what the scaffolded services serve
 * today (`src/shared/health.ts`). The ZEN `HLT‑01` clause renames it to
 * `/healthz/live` and is tracked separately (review §8, phase P3), so this
 * module is the single place that has to change when it lands.
 */

/** Base images, pinned to a full patch tag. */
export const BASE_IMAGES = {
  /** Node build/runtime stage — npm workspaces, NestJS, Next.js. */
  node: 'node:20.18.0-alpine3.20',
  /** Static-file runtime for a Vite/React build; already runs as uid 101. */
  nginxUnprivileged: 'nginxinc/nginx-unprivileged:1.27.5-alpine3.21',
  /** Python services (FastAPI/uvicorn). */
  python: 'python:3.12.7-slim',
  /** PHP/Laravel runtime. */
  php: 'php:8.3.13-cli',
  /** Composer binary, copied into the PHP build stage. */
  composer: 'composer:2.8.1',
  /** .NET build stage. */
  dotnetSdk: 'mcr.microsoft.com/dotnet/sdk:8.0.403',
  /** .NET ASP.NET runtime stage. */
  dotnetAspnet: 'mcr.microsoft.com/dotnet/aspnet:8.0.10',
  /** .NET console/worker runtime stage. */
  dotnetRuntime: 'mcr.microsoft.com/dotnet/runtime:8.0.10',
} as const;

/**
 * How a runtime image can be hardened, which decides how the health probe is
 * expressed and whether a user has to be created.
 */
export type RuntimeFamily =
  /** `node:*` — the image already ships a `node` user (uid 1000). */
  | 'node-alpine'
  /** `python:*-slim` — Debian, no curl/wget, probe with `urllib`. */
  | 'python-debian'
  /** `php:*-cli` — Debian, probe with `php -r`. */
  | 'php-debian'
  /** `aspnet:*` — installs curl, then drops to the built-in `APP_UID`. */
  | 'dotnet-web'
  /** `runtime:*` — no HTTP endpoint at all, so no `HEALTHCHECK`. */
  | 'dotnet-console'
  /** Unprivileged nginx — non-root already, probe the root path. */
  | 'nginx-static';

/** What the scaffolded services serve today; see the module comment. */
export const HEALTHCHECK_PATH = '/health';

const PROBE_FLAGS = '--interval=30s --timeout=3s --retries=3';

/**
 * The hardening tail appended to a Dockerfile, in the order it must appear:
 * non-root `USER` first, then `HEALTHCHECK` (which then also runs as that
 * user — a probe that only passes as root is a broken probe).
 *
 * The caller appends `EXPOSE`/`CMD` after these lines.
 */
export function hardeningLines(family: RuntimeFamily, port: number): string[] {
  const url = `http://127.0.0.1:${port}${HEALTHCHECK_PATH}`;
  switch (family) {
    case 'node-alpine':
      return [
        '# Non-root: the official node image already ships a `node` user (uid 1000).',
        'USER node',
        `HEALTHCHECK ${PROBE_FLAGS} --start-period=10s CMD wget -q --spider ${url} || exit 1`,
      ];

    case 'python-debian':
      return [
        '# Non-root: an unprivileged uid with no shell and no home-directory writes.',
        'RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app',
        'USER app',
        `HEALTHCHECK ${PROBE_FLAGS} --start-period=15s CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('${url}').status == 200 else 1)"`,
      ];

    case 'php-debian':
      return [
        '# Non-root: an unprivileged uid with no shell and no home-directory writes.',
        'RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app',
        'USER app',
        `HEALTHCHECK ${PROBE_FLAGS} --start-period=15s CMD php -r "exit(@file_get_contents('${url}') !== false ? 0 : 1);"`,
      ];

    case 'dotnet-web':
      return [
        '# Non-root: the .NET 8 images define APP_UID (1654) for exactly this.',
        'USER $APP_UID',
        `HEALTHCHECK ${PROBE_FLAGS} --start-period=20s CMD curl -fsS ${url} || exit 1`,
      ];

    case 'dotnet-console':
      return ['# Non-root: the .NET 8 images define APP_UID (1654) for exactly this.', 'USER $APP_UID'];

    case 'nginx-static':
      return [
        '# Already non-root: the unprivileged nginx image runs as uid 101 on :8080.',
        '# Stated explicitly so every generated Dockerfile carries a USER line.',
        'USER 101',
        `HEALTHCHECK ${PROBE_FLAGS} --start-period=5s CMD wget -q --spider http://127.0.0.1:${port}/ || exit 1`,
      ];

    default: {
      const exhaustive: never = family;
      throw new Error(`unknown runtime family: ${String(exhaustive)}`);
    }
  }
}

/**
 * `curl` is not in the ASP.NET runtime image, and a probe cannot be written in
 * a shell the image does not have. Emitted into the .NET runtime stage only.
 */
export const CURL_INSTALL_LINES = [
  'RUN apt-get update && apt-get install -y --no-install-recommends curl \\',
  '    && rm -rf /var/lib/apt/lists/*',
];
