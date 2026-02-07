# Claude Code Guidelines for CodeCritique

This is a JavaScript (ES modules) CLI project for AI-powered code review using RAG (Retrieval-Augmented Generation).

## Quick Reference

For comprehensive guidelines, see **AGENTS.md** in the project root.

## Project Overview

CodeCritique is an AI-powered code review tool that:

- Uses RAG to provide context-aware code analysis
- Generates local embeddings via FastEmbed for semantic search
- Integrates with Anthropic Claude for intelligent review
- Learns from PR history patterns in your repository
- Works with any programming language

## Tech Stack

- **Runtime**: Node.js >= 22.14.0
- **Language**: JavaScript (ES modules)
- **Testing**: Vitest
- **Storage**: LanceDB (vectors)

## Essential Rules

### Code Style

- JavaScript with ES modules (`import`/`export`)
- **Always use `.js` extensions in imports** (ESM requirement)
- Follow existing patterns in the codebase
- Use JSDoc for type documentation when helpful

### Testing

- Tests are co-located: `*.test.js` next to source files
- Use Vitest globals: `describe`, `it`, `expect`, `vi`
- Use `vi.hoisted()` for mocks configured before imports
- Temp directories for file-based tests: `mkdtemp(join(tmpdir(), 'test-'))`

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

### Architecture

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

### When Making Changes

1. Check existing patterns in the codebase first
2. Write tests for new functionality
3. Run `npm test` before completing
4. Update documentation if adding new features

### Commit Conventions

This project uses **semantic-release** for automated versioning. Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat`: New feature → Minor version bump
- `fix`: Bug fix → Patch version bump
- `chore`, `refactor`, `docs`, `test`: No release

**For feature PRs**: Use `feat` for the main commit, `chore`/`refactor` for follow-up fixes within the same PR (keeps release notes focused on the feature, not every small fix).

Commit bodies are included in release notes—use `-` bullet points for sub-features.

### Updating Agent Guidelines

When making significant changes (new features, patterns, architectural changes), update the agent instruction files: `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`, `CLAUDE.md`, `.clinerules`, `.roo/rules/01-project-rules.md`.

See **AGENTS.md** for detailed architecture, testing patterns, and mocking strategies.
