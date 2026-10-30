/**
 * Template dependency requirements for the /new-project wizard.
 *
 * The scaffolder itself only writes files, so a missing toolchain never blocks
 * project creation — what it blocks is *running* (or building, or installing)
 * the project afterwards. The wizard therefore probes the machine for what the
 * selected template needs and splits the result in two buckets:
 *
 *  - `checks` — runtimes, SDKs, package managers and VCS. Installing these
 *    needs elevation, a licence or a multi-GB download, so the host never
 *    attempts it. Each spec carries a paste-ready per-OS command plus a
 *    download URL so the user can comply manually.
 *  - `autoInstall` — project-level packages (`npm install`, `pip install -r …`,
 *    `dotnet restore`, `flutter pub get`). These are the ones ADO Code *can*
 *    fulfil autonomously: when the toolchain probe succeeds the host runs them
 *    itself inside the freshly scaffolded folder.
 *
 * Pure module: no fs, no child_process, no vscode. Probing lives in
 * `src/webview/projectDependencyProbe.ts`; the UI in
 * `src/webview-ui/src/components/ProjectCreationWizard/StepDependencies.tsx`.
 */

export type DependencyKind = 'runtime' | 'sdk' | 'package-manager' | 'vcs' | 'cli';

/**
 * How the user installs something the host refuses to install for them.
 *
 * A platform may list several commands: they render as ordered, copy-as-you-go
 * steps, which is what an SDK bootstrap really is (install the SDK, then let it
 * fetch its own sub-SDK). One string stays the common case.
 */
export interface DependencyInstallHint {
  win?: string | string[];
  mac?: string | string[];
  linux?: string | string[];
  url?: string;
  note?: string;
}

export interface DependencyProbe {
  cmd: string;
  args: string[];
}

export interface DependencySpec {
  id: string;
  /** Human label, including the minimum version the project needs. */
  label: string;
  /** What stops working without it — shown next to the status. */
  why: string;
  kind: DependencyKind;
  /** `true` → the wizard warns loudly and asks for an acknowledgement. */
  required: boolean;
  /** Tried in order; the first one that runs wins (python vs python3, …). */
  probes: DependencyProbe[];
  /** Major (or major.minor) floor; a lower version counts as missing. */
  minVersion?: string;
  install?: DependencyInstallHint;
}

/** A command the host runs itself, inside the new project (autonomous fix). */
export interface AutoInstallStep {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  /** Skipped when the scaffolded project has no such file (e.g. no requirements.txt). */
  requiresFile?: string;
}

export interface ProjectDependencyPlan {
  checks: DependencySpec[];
  autoInstall: AutoInstallStep[];
}

/** Probe outcome for one spec, shaped for the wizard UI. */
export interface DependencyStatus {
  id: string;
  label: string;
  why: string;
  kind: DependencyKind;
  required: boolean;
  /** Present *and* at least `minVersion`. */
  ok: boolean;
  version?: string;
  minVersion?: string;
  /** Paste-ready commands for the host platform, most specific first. */
  guidance: string[];
  url?: string;
  note?: string;
  /** Why the probe failed, when it did. */
  error?: string;
}

/**
 * The gate the Dependencies step hangs on, kept next to the report shape so the
 * webview step and the wizard's *Next* button cannot disagree about it.
 */
export interface DependencyGate {
  /** Required tools that were probed and not found. */
  blocking: DependencyStatus[];
  /** The plan carries project-package steps the host can run after scaffolding. */
  canAutoInstall: boolean;
  /** A missing required tool still waits for an "I will install it myself" tick. */
  blocked: boolean;
  /** The probe itself failed, so the report says nothing about the machine. */
  probeFailed: boolean;
}

/**
 * Decide whether a missing dependency gates the wizard.
 *
 * Creation is never blocked: the scaffolder only writes files, and a tool may be
 * installed outside PATH. A missing *required* tool therefore only demands an
 * explicit acknowledgement. A failed probe is a soft warning for the same reason.
 */
export function dependencyGate(
  report: Pick<DependencyReport, 'checks' | 'autoInstall' | 'error'> | null | undefined,
  acknowledged: boolean,
): DependencyGate {
  const blocking = report?.checks.filter(c => !c.ok && c.required) ?? [];
  const probeFailed = !!report?.error;
  return {
    blocking,
    canAutoInstall: (report?.autoInstall?.length ?? 0) > 0,
    blocked: !probeFailed && blocking.length > 0 && !acknowledged,
    probeFailed,
  };
}

export interface DependencyReport {
  /** `win32` | `darwin` | `linux` — decides which guidance line is shown first. */
  platform: string;
  checks: DependencyStatus[];
  /** Autonomous steps the host will run after scaffolding. */
  autoInstall: AutoInstallStep[];
  /** Labels of missing required dependencies (empty ⇒ nothing to acknowledge). */
  missingRequired: string[];
  /** Labels of missing optional dependencies. */
  missingOptional: string[];
  /** Set when the probe itself broke (the wizard then shows a soft warning). */
  error?: string;
}

// ──────────────────────────────────────────────────────────────
// Version handling
// ──────────────────────────────────────────────────────────────

/** First `x.y[.z]` in a version banner — `v20.11.1`, `Python 3.12.2`, `.NET 8.0.100`. */
export function parseVersion(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? m[0] : undefined;
}

/** Numeric segment compare; missing segments count as 0 (`20` == `20.0.0`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** `undefined` min ⇒ no floor; `undefined` version ⇒ cannot tell, so fail. */
export function meetsMinimum(version: string | undefined, min?: string): boolean {
  if (!min) return true;
  if (!version) return false;
  return compareVersions(version, min) >= 0;
}

/** One hint field as steps — `undefined` and blank entries vanish. */
function stepsOf(hint?: string | string[]): string[] {
  if (!hint) return [];
  return (Array.isArray(hint) ? hint : [hint]).map(step => step.trim()).filter(step => step.length > 0);
}

/** Guidance lines for one spec, on the platform doing the asking. */
export function guidanceFor(spec: DependencySpec, platform: string): string[] {
  const hint = spec.install;
  if (!hint) return [];
  // The OS closest to the one asking is the fallback, so a hint is never empty;
  // the first platform with steps wins outright.
  const candidates =
    platform === 'win32' ? [hint.win, hint.mac] : platform === 'darwin' ? [hint.mac, hint.linux] : [hint.linux, hint.mac];
  for (const candidate of candidates) {
    const steps = stepsOf(candidate);
    if (steps.length > 0) return steps;
  }
  return [];
}

// ──────────────────────────────────────────────────────────────
// Spec factories
// ──────────────────────────────────────────────────────────────

const NODE_INSTALL: DependencyInstallHint = {
  win: 'winget install OpenJS.NodeJS.LTS',
  mac: 'brew install node@20',
  linux: 'sudo apt install nodejs npm    # or: nvm install --lts',
  url: 'https://nodejs.org/en/download',
  note: 'ADO Code cannot install a runtime for you — install the LTS, then re-check.',
};

function nodeChecks(): DependencySpec[] {
  return [
    {
      id: 'node',
      label: 'Node.js 18+',
      why: 'Runs the build, the test runner and the dev server.',
      kind: 'runtime',
      required: true,
      probes: [{ cmd: 'node', args: ['--version'] }],
      minVersion: '18',
      install: NODE_INSTALL,
    },
    {
      id: 'npm',
      label: 'npm 9+',
      why: 'Installs the project packages after scaffolding.',
      kind: 'package-manager',
      required: true,
      probes: [{ cmd: 'npm', args: ['--version'] }],
      minVersion: '9',
      install: {
        ...NODE_INSTALL,
        note: 'npm ships with Node.js — fixing Node.js fixes this too.',
      },
    },
  ];
}

function nodeAutoInstall(pkgManager = 'npm'): AutoInstallStep[] {
  return [
    {
      id: `${pkgManager}-install`,
      label: `Install project packages (${pkgManager} install)`,
      cmd: pkgManager,
      args: ['install'],
      requiresFile: 'package.json',
    },
  ];
}

function pythonChecks(): DependencySpec[] {
  const install: DependencyInstallHint = {
    win: 'winget install Python.Python.3.12',
    mac: 'brew install python@3.12',
    linux: 'sudo apt install python3 python3-pip python3-venv',
    url: 'https://www.python.org/downloads/',
    note: 'Tick "Add python.exe to PATH" on Windows, then re-check.',
  };
  return [
    {
      id: 'python',
      label: 'Python 3.9+',
      why: 'Runs the project and its tests.',
      kind: 'runtime',
      required: true,
      probes: [{ cmd: 'python', args: ['--version'] }, { cmd: 'python3', args: ['--version'] }],
      minVersion: '3.9',
      install,
    },
    {
      id: 'pip',
      label: 'pip',
      why: 'Installs the requirements after scaffolding.',
      kind: 'package-manager',
      required: true,
      probes: [{ cmd: 'pip', args: ['--version'] }, { cmd: 'pip3', args: ['--version'] }],
      install: { ...install, note: 'pip ships with Python 3.4+ — fixing Python fixes this too.' },
    },
  ];
}

function pythonAutoInstall(): AutoInstallStep[] {
  return [
    {
      id: 'pip-install',
      label: 'Install requirements (pip install -r requirements.txt)',
      cmd: 'pip',
      args: ['install', '-r', 'requirements.txt'],
      requiresFile: 'requirements.txt',
    },
  ];
}

function dotnetChecks(): DependencySpec[] {
  return [
    {
      id: 'dotnet',
      label: '.NET SDK 8+',
      why: 'Restores, builds and runs the solution.',
      kind: 'sdk',
      required: true,
      probes: [{ cmd: 'dotnet', args: ['--version'] }],
      minVersion: '8',
      install: {
        win: 'winget install Microsoft.DotNet.SDK.8',
        mac: 'brew install --cask dotnet-sdk',
        linux: 'sudo apt install dotnet-sdk-8.0',
        url: 'https://dotnet.microsoft.com/download',
        note: 'The SDK (not just the runtime) is required — it brings `dotnet restore`.',
      },
    },
  ];
}

function flutterChecks(): DependencySpec[] {
  return [
    {
      id: 'flutter',
      label: 'Flutter SDK 3+',
      why: 'Generates android/ and ios/ runners and runs the app.',
      kind: 'sdk',
      required: true,
      probes: [{ cmd: 'flutter', args: ['--version'] }],
      minVersion: '3',
      install: {
        // Grounded in docs.flutter.dev/install, which offers two routes: the VS
        // Code extension (recommended — and this wizard already runs in VS Code),
        // then the manual zip. winget carries no Flutter SDK package at all:
        // `Flutter.Flutter` and `Google.Flutter` both answer "No package found"
        // against a refreshed index, so Windows gets no package-manager one-liner.
        win: [
          'Install the "Flutter" extension (Dart-Code.flutter), then run "Flutter: New Project"',
          'In the SDK prompt choose Download SDK → Clone Flutter → Add SDK to PATH',
          'Restart VS Code, open a NEW terminal, then: flutter doctor',
        ],
        // macOS/Linux keep the package-manager shortcut (both packages are real
        // and maintained) as a one-liner instead of the extension/zip walkthrough.
        mac: ['brew install --cask flutter', 'flutter doctor'],
        linux: ['sudo snap install flutter --classic', 'flutter doctor'],
        url: 'https://docs.flutter.dev/install',
        note: 'macOS/Linux use the package-manager shortcut (brew cask / snap classic); Windows follows the documented VS Code route. The `dart` CLI ships with Flutter: putting flutter/bin on PATH exposes both `flutter` and `dart`, so no separate Dart install is needed. `flutter doctor` only reports unaccepted Android licences — accept them with `flutter doctor --android-licenses`. If `flutter` is still not recognised, restart the terminal: PATH changes apply to new shells only. No-package-manager fallback: extract the release zip and add flutter/bin to PATH (docs.flutter.dev/install/manual).',
      },
    },
    {
      id: 'dart',
      label: 'Dart SDK 3+',
      why: 'Runs `flutter test` and the dart CLI; Flutter ships it, so this only checks PATH.',
      kind: 'sdk',
      // Bundled with Flutter ⇒ never a veto: a doctor-bootstrapped SDK that is
      // missing from PATH is a convenience problem, not a broken project.
      required: false,
      probes: [{ cmd: 'dart', args: ['--version'] }],
      minVersion: '3',
      install: {
        // dart.dev/get-dart documents exactly these routes. There is no core
        // `dart` Homebrew formula and no `dart` snap (both 404), which is why
        // macOS taps dart-lang/dart and Debian/Ubuntu add Google's apt repo.
        win: 'winget install --id=Google.DartSDK -e',
        mac: ['brew tap dart-lang/dart', 'brew trust dart-lang/dart', 'brew install dart'],
        linux: [
          'wget -qO- https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/dart.gpg',
          "echo 'deb [signed-by=/usr/share/keyrings/dart.gpg arch=amd64] https://storage.googleapis.com/download.dartlang.org/linux/debian stable main' | sudo tee /etc/apt/sources.list.d/dart_stable.list",
          'sudo apt-get update && sudo apt-get install dart',
        ],
        url: 'https://dart.dev/get-dart',
        note: 'Only needed for a bare `dart` command. Flutter ships its own `dart` and exposes it by putting flutter/bin on PATH, so this check is optional and never blocks the template.',
      },
    },
    {
      id: 'java',
      label: 'Java 17+ (Android builds)',
      why: 'Gradle needs a JDK to build the Android runner.',
      kind: 'runtime',
      required: false,
      probes: [{ cmd: 'java', args: ['-version'] }],
      minVersion: '17',
      install: {
        win: 'winget install Microsoft.OpenJDK.17',
        mac: 'brew install openjdk@17',
        linux: 'sudo apt install openjdk-17-jdk',
        url: 'https://adoptium.net/',
        note: 'Only needed for Android/iOS targets, not for web or desktop.',
      },
    },
  ];
}

function phpChecks(): DependencySpec[] {
  return [
    {
      id: 'php',
      label: 'PHP 8.1+',
      why: 'Runs Laravel and artisan.',
      kind: 'runtime',
      required: true,
      probes: [{ cmd: 'php', args: ['--version'] }],
      minVersion: '8.1',
      install: {
        win: 'winget install PHP.PHP.8.3',
        mac: 'brew install php@8.3',
        linux: 'sudo apt install php8.3-cli php8.3-mbstring php8.3-xml',
        url: 'https://www.php.net/downloads',
        note: 'The CLI build plus the mbstring and xml extensions are required.',
      },
    },
    {
      id: 'composer',
      label: 'Composer 2+',
      why: 'Installs the Laravel packages after scaffolding.',
      kind: 'package-manager',
      required: true,
      probes: [{ cmd: 'composer', args: ['--version'] }],
      minVersion: '2',
      install: {
        win: 'winget install Composer.Composer',
        mac: 'brew install composer',
        linux: 'sudo apt install composer',
        url: 'https://getcomposer.org/download/',
      },
    },
  ];
}

function gitCheck(required: boolean): DependencySpec {
  return {
    id: 'git',
    label: 'Git 2.30+',
    why: required
      ? 'Creates the repository, the branch and the initial commit.'
      : 'Optional: without it the scaffold is not versioned.',
    kind: 'vcs',
    required,
    probes: [{ cmd: 'git', args: ['--version'] }],
    minVersion: '2.30',
    install: {
      win: 'winget install Git.Git',
      mac: 'brew install git',
      linux: 'sudo apt install git',
      url: 'https://git-scm.com/downloads',
    },
  };
}

function pandocCheck(): DependencySpec {
  return {
    id: 'pandoc',
    label: 'Pandoc 3+',
    why: 'Only needed for the Word/PDF export of the generated documents.',
    kind: 'cli',
    required: false,
    probes: [{ cmd: 'pandoc', args: ['--version'] }],
    minVersion: '3',
    install: {
      win: 'winget install JohnMacFarlane.Pandoc',
      mac: 'brew install pandoc',
      linux: 'sudo apt install pandoc',
      url: 'https://pandoc.org/installing.html',
      note: 'The Markdown sources are the source of truth — export works without it, minus the conversion step.',
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Template mapping
// ──────────────────────────────────────────────────────────────

/**
 * What a template needs on this machine. Unknown template ids fall back to the
 * Git-only plan so an added template never crashes the wizard.
 */
export function planForTemplate(
  templateId: string,
  options: Record<string, unknown> = {},
  opts: { gitInit?: boolean } = {},
): ProjectDependencyPlan {
  const git = gitCheck(opts.gitInit !== false);
  const withGit = (checks: DependencySpec[], autoInstall: AutoInstallStep[] = []): ProjectDependencyPlan =>
    ({ checks: [...checks, git], autoInstall });

  const str = (key: string): string => (typeof options[key] === 'string' ? (options[key] as string) : '');
  const bool = (key: string): boolean => options[key] !== false;

  switch (templateId) {
    case 'node-ts':
    case 'node-js':
    case 'react-ts':
    case 'nextjs':
      return withGit(nodeChecks(), nodeAutoInstall());

    case 'monorepo-microservices': {
      const tool = str('workspaceTool') || str('packageManager');
      const pkgManager = tool === 'pnpm' || tool === 'yarn' ? tool : 'npm';
      const checks = nodeChecks();
      if (pkgManager !== 'npm') {
        checks.push({
          id: pkgManager,
          label: `${pkgManager} 1+`,
          why: 'Installs the workspace packages.',
          kind: 'package-manager',
          required: true,
          probes: [{ cmd: pkgManager, args: ['--version'] }],
          install: {
            win: `winget install ${pkgManager === 'pnpm' ? 'pnpm.pnpm' : 'Yarn.Yarn'}`,
            mac: `brew install ${pkgManager}`,
            linux: `npm install -g ${pkgManager}`,
            url: pkgManager === 'pnpm' ? 'https://pnpm.io/installation' : 'https://classic.yarnpkg.com/en/docs/install',
            note: `Also installable with: npm install -g ${pkgManager} (needs Node.js first).`,
          },
        });
      }
      return withGit(checks, nodeAutoInstall(pkgManager));
    }

    case 'react-native': {
      const expo = bool('expo');
      const checks = nodeChecks();
      if (!expo) {
        checks.push({
          id: 'java',
          label: 'Java 17+ (Android builds)',
          why: 'The bare React Native CLI builds with Gradle.',
          kind: 'runtime',
          required: false,
          probes: [{ cmd: 'java', args: ['-version'] }],
          minVersion: '17',
          install: {
            win: 'winget install Microsoft.OpenJDK.17',
            mac: 'brew install openjdk@17',
            linux: 'sudo apt install openjdk-17-jdk',
            url: 'https://adoptium.net/',
            note: 'Also needs the Android SDK + an emulator or a device.',
          },
        });
      }
      return withGit(checks, nodeAutoInstall());
    }

    case 'python':
      return withGit(pythonChecks(), pythonAutoInstall());

    case 'php-laravel':
      return withGit(phpChecks(), [
        {
          id: 'composer-install',
          label: 'Install packages (composer install)',
          cmd: 'composer',
          args: ['install', '--no-interaction'],
          requiresFile: 'composer.json',
        },
      ]);

    case 'dotnet-webapi':
    case 'dotnet-console':
    case 'dotnet-maui':
      return withGit(dotnetChecks(), [
        { id: 'dotnet-restore', label: 'Restore NuGet packages (dotnet restore)', cmd: 'dotnet', args: ['restore'] },
      ]);

    case 'flutter':
      return withGit(flutterChecks(), [
        {
          id: 'flutter-pub-get',
          label: 'Fetch Flutter packages (flutter pub get)',
          cmd: 'flutter',
          args: ['pub', 'get'],
          requiresFile: 'pubspec.yaml',
        },
      ]);

    case 'doc-ba':
    case 'doc-writer':
    case 'doc-tester':
      return { checks: [pandocCheck(), gitCheck(false)], autoInstall: [] };

    default:
      return { checks: [gitCheck(false)], autoInstall: [] };
  }
}
