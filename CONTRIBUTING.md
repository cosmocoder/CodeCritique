# Contributing to CodeCritique

Thank you for your interest in contributing to CodeCritique! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Commit Conventions](#commit-conventions)
- [Testing](#testing)
- [Adding New Features](#adding-new-features)
- [Pull Request Process](#pull-request-process)
- [Additional Resources](#additional-resources)

---

## Getting Started

1. **Fork the repository** on GitHub

2. **Clone your fork**

   ```bash
   git clone https://github.com/YOUR-USERNAME/CodeCritique.git
   cd CodeCritique
   ```

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```

---

## Development Setup

### Prerequisites

- Node.js >= 22.14.0
- npm >= 10.x
- Git (for diff-based analysis)
- Anthropic API key (for LLM analysis features)

### Environment Setup

1. **Create a `.env` file** in the project root:

   ```bash
   touch .env
   ```

2. **Add your API keys**:
   ```env
   ANTHROPIC_API_KEY=your_anthropic_api_key
   GITHUB_TOKEN=your_github_token  # Optional, for PR history analysis
   ```

### Key Commands

```bash
npm start                # Run the tool
npm run lint             # Run ESLint
npm run lint:fix         # Fix linting issues
npm run prettier         # Format code
npm run prettier:ci      # Check formatting (CI mode)
npm test                 # Run tests
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
npm run knip             # Check for unused dependencies
```

### Project Structure

```
src/
├── index.js                 # Main CLI entry point
├── llm.js                   # LLM integration (Anthropic Claude)
├── rag-analyzer.js          # RAG-based code analysis
├── rag-review.js            # Code review orchestration
├── project-analyzer.js      # Project structure analysis
├── content-retrieval.js     # Context retrieval for RAG
├── custom-documents.js      # Custom document processing
├── feedback-loader.js       # Feedback tracking utilities
├── zero-shot-classifier-open.js  # NLP classification
├── embeddings/              # FastEmbed vector generation & LanceDB storage
│   ├── factory.js           # Embeddings system factory
│   ├── database.js          # LanceDB database manager
│   ├── file-processor.js    # File processing for embeddings
│   ├── model-manager.js     # Embedding model management
│   └── ...
├── pr-history/              # PR history analysis
│   ├── analyzer.js          # PR history analyzer
│   ├── github-client.js     # GitHub API integration
│   ├── database.js          # PR comments storage
│   └── ...
├── utils/                   # Utility functions
│   ├── git.js               # Git operations
│   ├── file-validation.js   # File validation
│   └── ...
└── test-utils/              # Test utilities and fixtures
.github/
├── actions/                 # Reusable GitHub Actions
│   ├── generate-embeddings/ # Embedding generation action
│   ├── pr-review/           # PR review action
│   ├── setup-tool/          # Tool setup action
│   └── cleanup-artifacts/   # Artifact cleanup action
└── workflows/               # CI/CD workflows
```

---

## Code Style

### JavaScript Guidelines

- Use ES modules (`import`/`export`)
- Follow existing code patterns and conventions
- Use meaningful variable and function names
- Keep functions focused and under 50 lines when possible
- Add JSDoc comments for public APIs

### Formatting

- Run `npm run prettier` to format code before committing
- Run `npm run lint` to check for linting issues
- Use `npm run lint:fix` to automatically fix linting issues

### Important Constraints

- Keep code modular and maintainable
- Validate all user inputs
- Handle errors gracefully with meaningful messages
- Write self-documenting code with clear variable names

---

## Commit Conventions

This project uses [semantic-release](https://semantic-release.gitbook.io/) for automated versioning and release notes generation. Your commit messages directly impact the changelog and version bumps, so please follow these conventions carefully.

### Commit Message Format

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type**: The type of change (see below)
- **scope**: Optional, the area of the codebase affected (e.g., `embeddings`, `storage`, `cli`)
- **subject**: A short description of the change (imperative mood, no period)
- **body**: Optional, detailed description of the change
- **footer**: Optional, for breaking changes or issue references

### Commit Types and Release Impact

| Type       | Description                             | Release Impact                 |
| ---------- | --------------------------------------- | ------------------------------ |
| `feat`     | A new feature                           | **Minor** version bump (1.x.0) |
| `fix`      | A bug fix                               | **Patch** version bump (1.0.x) |
| `perf`     | Performance improvement                 | **Patch** version bump         |
| `docs`     | Documentation only                      | No release                     |
| `style`    | Code style (formatting, etc.)           | No release                     |
| `refactor` | Code change that neither fixes nor adds | No release                     |
| `test`     | Adding or updating tests                | No release                     |
| `chore`    | Maintenance tasks                       | No release                     |
| `ci`       | CI/CD changes                           | No release                     |
| `build`    | Build system changes                    | No release                     |

### Commit Strategy for Pull Requests

**For feature PRs:**

1. **Primary commit** — Use `feat` prefix for the main feature:

   ```
   feat(embeddings): add batch processing for large codebases
   ```

2. **Follow-up fixes within the same PR** — Use `chore` or `refactor` for bug fixes or improvements to your new feature:

   ```
   chore(embeddings): fix typo in batch processing logic
   refactor(embeddings): simplify chunk size calculation
   ```

   This ensures only the main feature appears in release notes, not every small fix you made while developing it.

3. **Unrelated bug fixes** — If you discover and fix a bug unrelated to your feature, use `fix`:
   ```
   fix(storage): handle null values in document metadata
   ```

**For bug fix PRs:**

- Use `fix` prefix for the primary commit:
  ```
  fix(cli): prevent crash when analyzing empty files
  ```

**For documentation/maintenance PRs:**

- Use `docs`, `chore`, `refactor`, etc. as appropriate

### Writing Good Commit Bodies

The commit body is included in release notes, so write it for your users! Use it to explain:

- What the change does and why
- Any important details or caveats
- Sub-features or components (use `-` for bullet points)

**Example:**

```
feat(pr-history): add date range filtering for PR analysis

Enhanced PR history analysis to support filtering by date range,
enabling more targeted analysis of recent changes.

Date Range Features:
- Add --since and --until flags for date filtering
- Support ISO date format (YYYY-MM-DD)
- Validate date ranges and provide helpful error messages

Performance Improvements:
- Skip PRs outside the date range early
- Reduce API calls for large repositories
```

### Breaking Changes

For breaking changes, add `BREAKING CHANGE:` in the commit footer:

```
feat(api): change output format for JSON analysis

BREAKING CHANGE: The JSON output now includes additional metadata fields.
Update your parsers to handle the new format.
```

This triggers a **major** version bump (x.0.0).

---

## Testing

### Test Framework

We use **Vitest** for testing.

### Test File Location

Tests are co-located with source files: `*.test.js` next to the source file.

- Example: `src/utils/file-validation.js` → `src/utils/file-validation.test.js`

### Writing Tests

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
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

---

## Adding New Features

### Adding a New Command

1. Define the command in `src/index.js` using Commander.js
2. Implement the command logic in a dedicated module
3. Add appropriate error handling and validation
4. Write tests for the new functionality
5. Update README.md with documentation

### Adding a New Output Format

1. Create a formatter function in the appropriate module
2. Add the format option to the relevant command
3. Write tests for the new format
4. Document the new format in README.md

### Adding Support for a New LLM Provider

1. Create a new provider module or extend `src/llm.js`
2. Implement the standard interface for LLM interactions (see existing `sendPrompt` function)
3. Add configuration options for the new provider (CLI flags, environment variables)
4. Write tests with mocked API responses
5. Document the new provider in README.md

---

## Pull Request Process

### Before Submitting

Run all checks:

```bash
npm run lint          # Linting passes
npm run prettier:ci   # Code is formatted
npm test              # All tests pass
npm run knip          # No unused dependencies
```

### Checklist

- [ ] Code follows existing patterns and style
- [ ] Tests added for new functionality
- [ ] All tests pass
- [ ] Linting passes
- [ ] Code is formatted with Prettier
- [ ] Documentation updated if needed
- [ ] Commit messages follow conventions

### Submitting

1. Push your changes to your fork
2. Create a Pull Request against the main repository
3. Fill in the PR template with a clear description of your changes
4. Wait for review and address any feedback

---

## Additional Resources

- **[README.md](README.md)** - Project overview and user documentation
- **[Architecture](docs/ARCHITECTURE.md)** - RAG architecture and component details
- **[Commands Reference](docs/COMMANDS.md)** - Complete CLI command documentation
- **[GitHub Actions](docs/GITHUB_ACTIONS.md)** - CI/CD integration guide
- **[Output Formats](docs/OUTPUT_FORMATS.md)** - Output format examples
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions

---

## Areas for Contribution

- **Language Support**: Add specialized rules for new programming languages
- **LLM Providers**: Integrate additional LLM providers (OpenAI, etc.)
- **Output Formats**: Add new output formats (XML, SARIF, etc.)
- **Performance**: Optimize embedding generation and search
- **Documentation**: Improve documentation and examples
- **Testing**: Add comprehensive test coverage

---

## Reporting Issues

Please use GitHub Issues to report bugs or request features. Include:

- **System information** (OS, Node.js version)
- **Command used** and **full error message**
- **Expected vs actual behavior**
- **Minimal reproduction case**

---

## Questions?

If you have questions about contributing, feel free to open an issue for discussion.
