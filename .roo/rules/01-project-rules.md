# CodeCritique - Project Rules

This is a JavaScript (ES modules) CLI project for AI-powered code review using RAG (Retrieval-Augmented Generation).

## Quick Reference

For comprehensive guidelines, see **AGENTS.md** in the project root.

## Project Context

- **Type**: CLI Tool (AI-powered code review)
- **Language**: JavaScript with ES modules
- **Runtime**: Node.js >= 22.14.0
- **Testing**: Vitest with global test APIs

## Essential Rules

### Code Style

- Use JavaScript with ES modules (`import`/`export`)
- **Always use `.js` extensions in imports** (ESM requirement)
- Follow existing patterns in the codebase
- Run `npm run lint` and `npm run prettier` before committing

### Testing

- Tests are co-located: `*.test.js` next to source files
- Use Vitest globals: `describe`, `it`, `expect`, `vi`
- Use `vi.hoisted()` for mocks that need to be configured before imports

### Critical Constraints

- Use proper async/await with try/catch error handling
- Always cleanup resources (LanceDB connections, etc.)
- Validate all user inputs
- Log errors with meaningful context

### Key Commands

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # Test with coverage
npm run lint          # Run ESLint
npm run lint:fix      # Fix linting issues
npm run prettier      # Format code
```

### Architecture Overview

```
src/
├── index.js          # Main CLI entry point (Commander.js)
├── llm.js            # LLM integration (Anthropic Claude)
├── rag-analyzer.js   # RAG-based code analysis
├── rag-review.js     # Code review orchestration
├── embeddings/       # FastEmbed + LanceDB storage
├── pr-history/       # GitHub PR history analysis
└── utils/            # Utility functions
```

### When Adding Features

1. Check existing patterns in the codebase first
2. Write tests for new functionality in corresponding `*.test.js` file
3. Run full test suite before submitting
4. Update documentation (README.md, docs/) if needed

### Commit Conventions

This project uses **semantic-release** for automated versioning. Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat`: New feature → Minor version bump
- `fix`: Bug fix → Patch version bump
- `chore`, `refactor`, `docs`, `test`: No release

**For feature PRs**: Use `feat` for the main commit, `chore`/`refactor` for follow-up fixes within the same PR (keeps release notes focused on the feature, not every small fix).

Commit bodies are included in release notes—use `-` bullet points for sub-features.

### Updating Agent Guidelines

When making significant changes (new features, patterns, architectural changes), update the agent instruction files: `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`, `CLAUDE.md`, `.clinerules`, `.roo/rules/01-project-rules.md`.

### Common Mocking Patterns

```javascript
// Hoisted mocks (configured before imports)
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('module', () => ({ default: mockFn }));

// Temporary directories for file-based tests
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'test-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
```

See **AGENTS.md** for detailed architecture, testing patterns, and mocking strategies.
