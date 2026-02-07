# CodeCritique - Agent Guidelines

This document provides comprehensive guidance for AI coding agents working on this project. It covers architecture, conventions, testing patterns, and best practices.

## Project Overview

**CodeCritique** is an AI-powered code review tool using **RAG (Retrieval-Augmented Generation)** with local embeddings and Anthropic Claude for intelligent, context-aware code analysis. It works with any programming language.

### Key Features

- **Context-Aware Analysis**: Understands codebase patterns and conventions via embeddings
- **Universal Language Support**: Works with any programming language
- **Local Embeddings**: Uses FastEmbed for fast, privacy-respecting semantic search
- **PR History Learning**: Learns from past code review patterns in your repository
- **Custom Guidelines**: Integrates team's coding standards and documentation
- **Multiple Output Formats**: Text, JSON, and Markdown output

### Tech Stack

- **Runtime**: Node.js >= 22.14.0
- **Language**: JavaScript (ES modules)
- **Testing**: Vitest with coverage
- **Linting**: ESLint
- **Formatting**: Prettier
- **Key Dependencies**:
  - `@anthropic-ai/sdk` - LLM integration (Claude)
  - `fastembed` - Local embedding generation
  - `@lancedb/lancedb` - Vector database for embeddings
  - `@huggingface/transformers` - NLP tasks (zero-shot classification)
  - `@octokit/rest` - GitHub API for PR history analysis
  - `commander` - CLI framework

---

## Architecture

### High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CodeCritique CLI                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   Embeddings    │  │   PR History    │  │     Content Retrieval   │  │
│  │  (FastEmbed +   │  │    Analysis     │  │   (Context for RAG)     │  │
│  │    LanceDB)     │  │  (GitHub API)   │  │                         │  │
│  └────────┬────────┘  └────────┬────────┘  └───────────┬─────────────┘  │
│           │                    │                       │                 │
│           └────────────────────┼───────────────────────┘                 │
│                                │                                         │
│                    ┌───────────▼───────────┐                            │
│                    │   RAG Analyzer        │                            │
│                    │  (LLM + Context)      │                            │
│                    └───────────┬───────────┘                            │
│                                │                                         │
│                    ┌───────────▼───────────┐                            │
│                    │   Code Review Output  │                            │
│                    │  (Text/JSON/Markdown) │                            │
│                    └───────────────────────┘                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### RAG-Based Analysis Flow

1. **Generate Embeddings**: Process codebase files → create vector embeddings → store in LanceDB
2. **Analyze PR History** (optional): Fetch PR comments from GitHub → extract patterns → store for context
3. **Code Review**: Retrieve similar code examples + documentation → provide context to LLM → generate review

---

## Directory Structure

```
src/
├── index.js                 # Main CLI entry point (Commander.js)
├── llm.js                   # LLM integration (Anthropic Claude)
├── rag-analyzer.js          # RAG-based code analysis
├── rag-review.js            # Code review orchestration
├── project-analyzer.js      # Project structure analysis
├── content-retrieval.js     # Context retrieval for RAG
├── custom-documents.js      # Custom document processing
├── feedback-loader.js       # Feedback tracking utilities
├── zero-shot-classifier-open.js  # NLP classification
│
├── embeddings/              # FastEmbed vector generation & LanceDB storage
│   ├── factory.js           # Embeddings system factory
│   ├── database.js          # LanceDB database manager
│   ├── file-processor.js    # File processing for embeddings
│   ├── model-manager.js     # Embedding model management
│   ├── cache-manager.js     # Caching layer
│   ├── similarity-calculator.js  # Vector similarity search
│   ├── constants.js         # Embedding constants
│   ├── errors.js            # Custom error classes
│   └── types.js             # JSDoc type definitions
│
├── pr-history/              # PR history analysis
│   ├── analyzer.js          # PR history analyzer
│   ├── github-client.js     # GitHub API integration
│   ├── database.js          # PR comments storage
│   ├── bot-detector.js      # Bot detection for filtering
│   ├── comment-processor.js # Comment processing
│   └── cli-utils.js         # CLI display utilities
│
├── utils/                   # Utility functions
│   ├── command.js           # Safe command execution
│   ├── constants.js         # Global constants
│   ├── context-inference.js # Context inference utilities
│   ├── document-detection.js # Document type detection
│   ├── file-validation.js   # File validation utilities
│   ├── git.js               # Git operations
│   ├── language-detection.js # Programming language detection
│   ├── logging.js           # Logging utilities
│   ├── markdown.js          # Markdown processing
│   ├── mobilebert-tokenizer.js # Tokenization utilities
│   ├── pr-chunking.js       # PR chunking for large diffs
│   └── string-utils.js      # String manipulation utilities
│
├── test-utils/              # Test utilities and fixtures
│   ├── console-suppression.js # Console suppression for tests
│   └── fixtures.js          # Test fixtures
│
├── setupTests.js            # Vitest global test setup
├── codecritique.sh          # Shell script wrapper
└── technology-keywords.json # Technology detection keywords

.github/
├── actions/                 # Reusable GitHub Actions
│   ├── generate-embeddings/ # Embedding generation action
│   ├── pr-review/           # PR review action
│   ├── setup-tool/          # Tool setup action
│   └── cleanup-artifacts/   # Artifact cleanup action
└── workflows/               # CI/CD workflows

docs/
├── ARCHITECTURE.md          # RAG architecture documentation
├── COMMANDS.md              # CLI command reference
├── GITHUB_ACTIONS.md        # GitHub Actions integration guide
├── OUTPUT_FORMATS.md        # Output format examples
└── TROUBLESHOOTING.md       # Troubleshooting guide
```

---

## Module Responsibilities

### `src/index.js` - Main CLI

The main entry point handling:

- Command registration (Commander.js)
- CLI argument parsing
- Signal handling (SIGINT/SIGTERM)
- Coordination of review workflows

### `src/embeddings/` - Vector Storage

- **`factory.js`**: Creates and manages embeddings system instances
- **`database.js`**: LanceDB operations for storing/querying vectors
- **`file-processor.js`**: Processes code files into embeddable chunks
- **`model-manager.js`**: Manages FastEmbed model lifecycle
- **`similarity-calculator.js`**: Vector similarity search implementation

### `src/pr-history/` - PR Analysis

- **`analyzer.js`**: Orchestrates PR history analysis
- **`github-client.js`**: GitHub API interactions via Octokit
- **`database.js`**: Storage for PR comments and patterns
- **`bot-detector.js`**: Filters out automated bot comments

### `src/utils/` - Utilities

- **`git.js`**: Git operations (diff, branch detection, etc.)
- **`file-validation.js`**: File type and content validation
- **`language-detection.js`**: Detects programming languages using linguist-languages
- **`command.js`**: Safe shell command execution

---

## Testing Patterns

### Test File Naming

- Tests are co-located with source files: `*.test.js`
- Example: `src/utils/file-validation.js` → `src/utils/file-validation.test.js`

### Test Framework

- **Vitest** with global test APIs (`describe`, `it`, `expect`, `vi`)
- Configuration in `vitest.config.js`
- Global setup in `src/setupTests.js`

### Test Structure

```javascript
import { describe, it, expect, vi } from 'vitest';
import { functionUnderTest } from './module.js';

describe('ModuleName', () => {
  describe('functionOrMethod', () => {
    it('should do expected behavior', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = functionUnderTest(input);

      // Assert
      expect(result).toBe('expected');
    });

    it('should handle edge case', () => {
      // ...
    });
  });
});
```

### Async Testing

```javascript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Test Isolation

- Each test file runs in isolation
- `beforeEach`/`afterEach` for setup/cleanup
- Temporary directories for file-based tests:

```javascript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'test-prefix-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
```

---

## Mocking Strategies

### 1. Global Mocks (setupTests.js)

Mocks applied to all tests:

```javascript
// Mock console methods to reduce test output noise
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
```

### 2. Module Mocks with vi.mock()

For external dependencies:

```javascript
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: vi.fn() };
    }
  },
}));
```

### 3. Hoisted Mocks

When mock needs to be configured before import:

```javascript
const { mockFunction } = vi.hoisted(() => ({
  mockFunction: vi.fn(),
}));

vi.mock('some-module', () => ({
  default: mockFunction,
}));

// Later in tests:
mockFunction.mockResolvedValue('value');
```

### 4. Partial Mocks

When you need real implementation with some mocks:

```javascript
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue('mocked content'),
  };
});
```

### 5. Inline Mocks

For test-specific behavior:

```javascript
it('should handle specific case', async () => {
  mockFunction.mockResolvedValueOnce(specificValue);
  // Test runs with this specific mock
});
```

### 6. Spy Functions

For tracking calls without replacing:

```javascript
const spy = vi.spyOn(object, 'method');
// ... perform actions
expect(spy).toHaveBeenCalledWith(expectedArgs);
```

---

## Code Style Guidelines

### JavaScript

- ES modules (`import`/`export`)
- No TypeScript, pure JavaScript
- JSDoc for type documentation when helpful
- Meaningful variable and function names
- Keep functions focused and under 50 lines when possible

### Imports

- Use relative paths with `.js` extensions
- Group imports: external deps, then internal modules

```javascript
import { Something } from 'external-package';
import { Internal } from './internal.js';
```

### Error Handling

- Use custom error classes when appropriate (see `src/embeddings/errors.js`)
- Handle errors gracefully with meaningful messages
- Log errors with context

### Async/Await

- Prefer async/await over raw promises
- Use proper error handling with try/catch

---

## Common Development Tasks

### Running Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

### Linting and Formatting

```bash
npm run lint          # Run ESLint
npm run lint:fix      # Fix linting issues
npm run prettier      # Format with Prettier
npm run prettier:ci   # Check formatting (CI mode)
```

### Running the Tool

```bash
npm start analyze --file src/app.js           # Analyze single file
npm start embeddings:generate --directory src  # Generate embeddings
npm start pr-history:analyze                  # Analyze PR history
```

### Adding a New Command

1. Define the command in `src/index.js` using Commander.js:

```javascript
program
  .command('my-command')
  .description('Description of what the command does')
  .option('-f, --flag <value>', 'Option description')
  .action(myCommandHandler);
```

2. Implement the handler function
3. Add appropriate error handling and validation
4. Write tests for the new functionality
5. Update README.md and docs/COMMANDS.md with documentation

### Adding a New Utility

1. Create utility file in `src/utils/`:

```javascript
// src/utils/my-utility.js

/**
 * Description of what this function does
 * @param {string} input - Input description
 * @returns {string} Return value description
 */
export function myUtility(input) {
  // Implementation
}
```

2. Write tests in `src/utils/my-utility.test.js`
3. Export from the utility if needed by other modules

### Adding GitHub Action Changes

1. Actions are located in `.github/actions/`
2. Each action has its own directory with:
   - `action.yml` - Action definition
   - `*.js` - Implementation files
   - `*.test.js` - Tests
3. Run tests: `npm test -- .github/actions/`

---

## Key Interfaces

### Review Result Structure

```javascript
{
  success: boolean,
  filePath: string,
  language: string,
  results: {
    summary: string,
    issues: [{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info',
      description: string,
      suggestion: string,
      lineNumbers: number[],
      codeSuggestion?: {
        startLine: number,
        endLine: number,
        oldCode: string,
        newCode: string
      }
    }],
    positives: string[]
  },
  skipped: boolean,
  error: string | undefined
}
```

### Embedding Entry

```javascript
{
  id: string,           // Unique identifier
  filePath: string,     // Path to source file
  content: string,      // Chunk content
  vector: number[],     // Embedding vector (384 dimensions)
  projectPath: string,  // Project root path
  timestamp: number     // Creation timestamp
}
```

### PR Comment Entry

```javascript
{
  id: string,
  repository: string,
  prNumber: number,
  author: string,
  body: string,
  createdAt: string,
  path: string,         // File path for inline comments
  line: number,         // Line number for inline comments
  isBot: boolean
}
```

---

## Important Notes

### Environment Variables

- `ANTHROPIC_API_KEY` - Required for LLM analysis
- `GITHUB_TOKEN` - Required for PR history analysis
- `DEBUG` - Enable debug output
- `VERBOSE` - Enable verbose output

### Embedding Dimensions

- FastEmbed produces 384-dimensional vectors
- Default model: `BAAI/bge-small-en-v1.5`

### Storage Paths

- Default data directory: `~/.codecritique/`
- Embeddings stored in LanceDB format
- PR history stored in SQLite

### Process Cleanup

- The tool registers SIGINT/SIGTERM handlers
- Always ensure cleanup of resources (LanceDB connections, etc.)
- Use the `embeddingsSystem.cleanup()` method

---

## Debugging Tips

1. **Test failures**: Check if mocks are properly hoisted
2. **Embedding issues**: Verify LanceDB connection is cleaned up
3. **Git operations**: Ensure working directory is a valid git repository
4. **LLM errors**: Check API key and rate limits
5. **Memory issues**: Large codebases may need `--max-lines` option

---

## Commit Conventions

This project uses **semantic-release** for automated versioning. Commit messages directly impact releases and changelogs.

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Commit Types and Release Impact

| Type                                                        | Release Impact             |
| ----------------------------------------------------------- | -------------------------- |
| `feat`                                                      | Minor version bump (1.x.0) |
| `fix`                                                       | Patch version bump (1.0.x) |
| `perf`                                                      | Patch version bump         |
| `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build` | No release                 |

### Commit Strategy for PRs

- **Feature PRs**: Use `feat` for the primary commit. Use `chore`/`refactor` for follow-up fixes to the same feature.
- **Bug fix PRs**: Use `fix` for the primary commit.
- **Unrelated bugs**: If you find an unrelated bug while working, use `fix`.

### Writing Commit Bodies

The commit body appears in release notes. Include:

- What the change does and why
- Sub-features using `-` bullet points

**Example:**

```
feat(embeddings): add batch processing for large codebases

Batch Processing:
- Add configurable batch size for embedding generation
- Implement progress tracking with spinner
- Support graceful interruption with cleanup
```

See **CONTRIBUTING.md** for detailed commit guidelines.

---

## Contributing Checklist

- [ ] Code follows existing patterns and style
- [ ] Tests added for new functionality
- [ ] Tests pass: `npm test`
- [ ] Linting passes: `npm run lint`
- [ ] Code formatted: `npm run prettier`
- [ ] Commit messages follow conventional commits format
- [ ] Documentation updated if needed

---

## Maintaining Agent Guidelines

When making significant changes to the codebase (new features, architectural changes, new patterns, etc.), **update the agent instruction files**. These files help AI agents understand the project:

- `AGENTS.md` - Comprehensive guidelines (primary reference)
- `CONTRIBUTING.md` - Contributor guidelines
- `.cursorrules` - Cursor IDE rules
- `CLAUDE.md` - Claude Code guidelines
- `.clinerules` - Cline rules
- `.roo/rules/01-project-rules.md` - Roo/Cline rules

Keep all these files in sync when updating documentation.
