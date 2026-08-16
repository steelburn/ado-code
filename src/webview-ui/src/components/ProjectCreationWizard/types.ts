export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'frontend' | 'backend' | 'fullstack' | 'cli' | 'library';
  options: TemplateOption[];
}

export interface TemplateOption {
  id: string;
  label: string;
  type: 'boolean' | 'select' | 'input';
  default: any;
  options?: string[];  // For select type
  description?: string;
}

export interface WizardState {
  step: number;
  templateId: string | null;
  projectName: string;
  projectDescription: string;
  projectVersion: string;
  templateOptions: Record<string, any>;
  adoIntegration: boolean;
  adoWorkItemType: string;
  adoAreaPath: string;
  gitInit: boolean;
  gitInitialCommit: boolean;
  gitBranchName: string;
}

export interface ProjectCreationRequest {
  templateId: string;
  projectName: string;
  projectDescription: string;
  projectVersion: string;
  templateOptions: Record<string, any>;
  adoIntegration: boolean;
  adoWorkItemType: string;
  adoAreaPath: string;
  gitInit: boolean;
  gitInitialCommit: boolean;
  gitBranchName: string;
  targetPath: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'node-ts',
    name: 'Node.js (TypeScript)',
    description: 'TypeScript project with optional ESLint, Prettier, and testing setup',
    icon: '📦',
    category: 'backend',
    options: [
      { id: 'eslint', label: 'Add ESLint', type: 'boolean', default: true },
      { id: 'prettier', label: 'Add Prettier', type: 'boolean', default: true },
      { id: 'jest', label: 'Add Jest testing', type: 'boolean', default: true },
      { id: 'docker', label: 'Add Dockerfile', type: 'boolean', default: false },
    ],
  },
  {
    id: 'node-js',
    name: 'Node.js (JavaScript)',
    description: 'JavaScript project with optional ESLint and testing',
    icon: '📦',
    category: 'backend',
    options: [
      { id: 'eslint', label: 'Add ESLint', type: 'boolean', default: true },
      { id: 'jest', label: 'Add Jest testing', type: 'boolean', default: true },
    ],
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Python project with pyproject.toml and optional virtual env setup',
    icon: '🐍',
    category: 'backend',
    options: [
      { id: 'pytest', label: 'Add pytest', type: 'boolean', default: true },
      { id: 'black', label: 'Add Black formatter', type: 'boolean', default: true },
      { id: 'mypy', label: 'Add mypy type checking', type: 'boolean', default: false },
    ],
  },
  {
    id: 'react-ts',
    name: 'React (TypeScript)',
    description: 'React app with TypeScript, Vite, and optional Tailwind CSS',
    icon: '⚛️',
    category: 'frontend',
    options: [
      { id: 'tailwind', label: 'Add Tailwind CSS', type: 'boolean', default: false },
      { id: 'eslint', label: 'Add ESLint', type: 'boolean', default: true },
      { id: 'prettier', label: 'Add Prettier', type: 'boolean', default: true },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    description: 'Full-stack React framework with SSR/SSG',
    icon: '▲',
    category: 'fullstack',
    options: [
      { id: 'tailwind', label: 'Add Tailwind CSS', type: 'boolean', default: true },
      { id: 'prisma', label: 'Add Prisma ORM', type: 'boolean', default: false },
      { id: 'auth', label: 'Add NextAuth.js', type: 'boolean', default: false },
    ],
  },
  {
    id: 'php-laravel',
    name: 'PHP (Laravel)',
    description: 'Laravel 11 project with basic structure',
    icon: '🐘',
    category: 'backend',
    options: [
      { id: 'sail', label: 'Add Laravel Sail (Docker)', type: 'boolean', default: true },
      { id: 'pest', label: 'Use Pest for testing', type: 'boolean', default: true },
    ],
  },
  {
    id: 'dotnet-webapi',
    name: '.NET (C# Web API)',
    description: 'ASP.NET Core Web API project',
    icon: '🔷',
    category: 'backend',
    options: [
      { id: 'swagger', label: 'Add Swagger/OpenAPI', type: 'boolean', default: true },
      { id: 'docker', label: 'Add Dockerfile', type: 'boolean', default: false },
    ],
  },
  {
    id: 'dotnet-console',
    name: '.NET (C# Console)',
    description: '.NET console application',
    icon: '🔷',
    category: 'cli',
    options: [],
  },
  {
    id: 'empty',
    name: 'Empty Project',
    description: 'Start with just a README and .gitignore',
    icon: '📄',
    category: 'library',
    options: [
      { id: 'readme', label: 'Add README.md', type: 'boolean', default: true },
      { id: 'gitignore', label: 'Add .gitignore', type: 'boolean', default: true },
      { id: 'license', label: 'Add LICENSE', type: 'select', default: 'MIT', options: ['MIT', 'Apache-2.0', 'GPL-3.0', 'None'] },
    ],
  },
];
