// src/shared/skillTypes.ts

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: SkillCategory;
  tags: string[];
  icon: string;
  
  // Skill content
  prompt?: string;           // Prompt template
  toolChain?: ToolChainStep[];  // Tool execution sequence
  knowledge?: string;        // Knowledge base content
  
  // Metadata
  installed: boolean;
  enabled: boolean;
  builtin: boolean;          // Ships with extension
  source: 'builtin' | 'marketplace' | 'local';
  
  // Configuration
  config?: SkillConfig[];
}

export type SkillCategory = 
  | 'code-review'
  | 'documentation'
  | 'testing'
  | 'refactoring'
  | 'deployment'
  | 'database'
  | 'security'
  | 'performance'
  | 'accessibility'
  | 'custom';

export interface ToolChainStep {
  tool: string;
  args: Record<string, any>;
  condition?: string;  // Optional condition for execution
}

export interface SkillConfig {
  id: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  default: any;
  options?: string[];
  description?: string;
}

export interface SkillExecutionRequest {
  skillId: string;
  input: string;
  context?: Record<string, any>;
  config?: Record<string, any>;
}

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  toolCalls?: Array<{ tool: string; args: any; result: any }>;
  error?: string;
}

// Built-in skills that ship with the extension
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Perform a thorough code review with focus on quality, security, and best practices',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'code-review',
    tags: ['review', 'quality', 'security'],
    icon: '🔍',
    prompt: `Review the provided code changes with focus on:
1. **Code Quality**: Readability, maintainability, DRY principles
2. **Security**: Potential vulnerabilities, input validation, secrets exposure
3. **Performance**: Unnecessary operations, optimization opportunities
4. **Best Practices**: Language-specific patterns, error handling
5. **Tests**: Coverage gaps, edge cases

Provide specific, actionable feedback with line references where applicable.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'documentation-gen',
    name: 'Documentation Generator',
    description: 'Generate comprehensive documentation for code files or APIs',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'documentation',
    tags: ['docs', 'comments', 'readme'],
    icon: '📝',
    prompt: `Generate documentation for the provided code:
1. **Overview**: What the code does and its purpose
2. **API Reference**: Functions, classes, parameters, return values
3. **Usage Examples**: Common use cases with code samples
4. **Edge Cases**: Error conditions and handling
5. **Dependencies**: Required imports and external dependencies

Use clear, concise language. Include JSDoc/TSDoc comments where appropriate.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'test-generator',
    name: 'Test Generator',
    description: 'Generate unit tests with good coverage and edge cases',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'testing',
    tags: ['tests', 'unit', 'coverage'],
    icon: '🧪',
    prompt: `Generate comprehensive unit tests for the provided code:
1. **Happy Path**: Test normal, expected behavior
2. **Edge Cases**: Empty inputs, null values, boundaries
3. **Error Cases**: Invalid inputs, exception handling
4. **Integration Points**: Mock external dependencies
5. **Assertions**: Meaningful assertions with clear messages

Use the project's existing test framework. Follow naming conventions.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'refactor-assist',
    name: 'Refactoring Assistant',
    description: 'Identify refactoring opportunities and apply safe transformations',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'refactoring',
    tags: ['refactor', 'clean', 'patterns'],
    icon: '♻️',
    prompt: `Analyze the code and suggest refactoring improvements:
1. **Code Smells**: Long methods, duplicated code, large classes
2. **Design Patterns**: Applicable patterns to simplify structure
3. **SOLID Principles**: Violations and fixes
4. **Extract Methods**: Break down complex functions
5. **Rename/Reorganize**: Improve naming and file structure

Provide before/after examples. Ensure refactoring preserves behavior.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Scan code for security vulnerabilities and compliance issues',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'security',
    tags: ['security', 'audit', 'vulnerabilities'],
    icon: '🔒',
    prompt: `Perform a security audit of the provided code:
1. **Injection Vulnerabilities**: SQL, XSS, command injection
2. **Authentication**: Password handling, token management
3. **Authorization**: Access control, privilege escalation
4. **Data Exposure**: Secrets, PII, sensitive data logging
5. **Dependencies**: Known vulnerabilities in packages

Rate severity (Critical/High/Medium/Low) and provide remediation steps.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'performance-profiler',
    name: 'Performance Profiler',
    description: 'Identify performance bottlenecks and optimization opportunities',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'performance',
    tags: ['performance', 'optimization', 'profiling'],
    icon: '⚡',
    prompt: `Analyze the code for performance issues:
1. **Time Complexity**: Algorithm efficiency (Big O)
2. **Space Complexity**: Memory usage and allocations
3. **I/O Operations**: Database queries, file access, network calls
4. **Caching Opportunities**: Memoization, result caching
5. **Concurrency**: Parallelization possibilities

Provide specific optimization suggestions with expected impact.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'deployment-checklist',
    name: 'Deployment Checklist',
    description: 'Generate deployment readiness checklists and infrastructure configs',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'deployment',
    tags: ['deploy', 'ci-cd', 'infrastructure', 'docker'],
    icon: '🚀',
    prompt: `Analyze the project and generate a deployment checklist:
1. **Environment Variables**: Required secrets and configuration
2. **Dependencies**: Runtime requirements and version pinning
3. **Health Checks**: Endpoints and monitoring setup
4. **Rollback Plan**: Steps to revert if deployment fails
5. **Infrastructure**: Dockerfile, docker-compose, or IaC templates needed

Include specific commands and configuration snippets.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'db-schema-review',
    name: 'Database Schema Review',
    description: 'Review database schemas, migrations, and query patterns',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'database',
    tags: ['database', 'sql', 'schema', 'migration'],
    icon: '🗄️',
    prompt: `Review database-related code:
1. **Schema Design**: Normalization, indexes, constraints
2. **Migrations**: Safety, rollback capability, data integrity
3. **Query Performance**: N+1 queries, missing indexes, full scans
4. **Security**: SQL injection, parameterized queries, access control
5. **Data Model**: Entity relationships, foreign keys, cascade rules

Suggest improvements with specific SQL examples.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
  {
    id: 'a11y-audit',
    name: 'Accessibility Audit',
    description: 'Audit code for WCAG compliance and accessibility best practices',
    version: '1.0.0',
    author: 'ADO Code',
    category: 'accessibility',
    tags: ['a11y', 'wcag', 'aria', 'screen-reader'],
    icon: '♿',
    prompt: `Audit the code for accessibility:
1. **Semantic HTML**: Proper heading hierarchy, landmark regions
2. **ARIA Attributes**: Labels, roles, states, live regions
3. **Keyboard Navigation**: Tab order, focus management, shortcuts
4. **Color & Contrast**: Text visibility, color-blind friendly palettes
5. **Screen Readers**: Alt text, hidden content, announcements

Reference WCAG 2.1 AA criteria. Provide fix examples.`,
    installed: true,
    enabled: true,
    builtin: true,
    source: 'builtin',
  },
];
