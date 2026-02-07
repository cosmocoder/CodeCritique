# CodeCritique

[![npm version](https://img.shields.io/npm/v/codecritique.svg)](https://www.npmjs.com/package/codecritique)
[![npm downloads](https://img.shields.io/npm/dm/codecritique.svg)](https://www.npmjs.com/package/codecritique)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.14.0-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/cosmocoder/CodeCritique/actions/workflows/release.yml/badge.svg)](https://github.com/cosmocoder/CodeCritique/actions/workflows/release.yml)

**AI-Powered Code Review. Context-Aware. Privacy-First.**

A self-hosted code review tool using **RAG (Retrieval-Augmented Generation)** with local embeddings and Anthropic Claude for intelligent, context-aware code analysis. Works with any programming language.

[Features](#key-features) • [Installation](#installation) • [Quick Start](#quick-start) • [GitHub Actions](#github-actions-integration) • [Commands](#commands-reference) • [Contributing](#contributing)

---

## ❌ The Problem

Traditional code review tools fall short:

- ❌ **Generic static analysis** doesn't understand your codebase's unique patterns
- ❌ **No historical context** - ignores lessons from past code reviews
- ❌ **One-size-fits-all** rules that don't adapt to your team's standards
- ❌ **Limited language support** - often focused on specific tech stacks

## ✅ The Solution

**CodeCritique** uses RAG to deliver intelligent, context-aware code reviews:

- ✅ **Learns your codebase** - embeddings capture your patterns and conventions
- ✅ **Remembers PR history** - learns from past review comments and decisions
- ✅ **Custom guidelines** - integrates your team's coding standards
- ✅ **Any language** - works with JavaScript, Python, Go, Rust, and more

---

## 🚀 Quick Install

```bash
npx codecritique analyze --file src/app.ts
```

Or install globally:

```bash
npm install -g codecritique
```

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [GitHub Actions Integration](#github-actions-integration)
- [Commands Reference](#commands-reference)
- [Configuration](#configuration)
- [Contributing](#contributing)
- [License](#license)

## Overview

### How RAG Powers Intelligent Code Review

CodeCritique uses **Retrieval-Augmented Generation (RAG)** to provide context-aware code analysis by combining:

- **Local embeddings** (via FastEmbed) for understanding your codebase patterns
- **Vector similarity search** to find relevant code examples and documentation
- **Historical PR analysis** to learn from past code review patterns
- **Custom document integration** for project-specific guidelines
- **LLM-powered analysis** (Anthropic Claude) with rich contextual information

This RAG-based approach provides more accurate, project-specific code reviews compared to generic static analysis tools.

### Key Features

- **🔍 Context-Aware Analysis**: Understands your codebase patterns and conventions
- **🌐 Universal Language Support**: Works with any programming language
- **⚡ Local Embeddings**: Uses FastEmbed for fast, privacy-respecting semantic search
- **📚 Custom Guidelines**: Integrate your team's coding standards and documentation
- **🔄 PR History Learning**: Learns from past code review patterns in your repository
- **📊 Multiple Output Formats**: Text, JSON, and Markdown output for flexible integration
- **🔧 Git Integration**: Analyze specific files, patterns, or branch differences
- **🚀 Easy Setup**: Works via npx in any project type

### Benefits

- **Reduced Review Time**: Automate repetitive aspects of code review
- **Consistent Standards**: Enforce coding standards uniformly across the codebase
- **Learning from History**: Leverage patterns from previous code reviews
- **Project-Specific**: Understands your codebase's unique patterns and conventions
- **Actionable Feedback**: Provides specific, constructive suggestions

## Installation

### Prerequisites

- **Node.js** v22.14.0 or higher
- **Git** (for diff-based analysis)
- **Anthropic API key** (for LLM analysis)

### API Key Setup

Set up your Anthropic API key using one of these methods:

#### Option 1: Environment Variable

```bash
export ANTHROPIC_API_KEY=your_anthropic_api_key
```

#### Option 2: .env File

Create a `.env` file in your project directory:

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
```

#### Option 3: Inline with Command

```bash
ANTHROPIC_API_KEY=your_key npx codecritique analyze --file app.py
```

### Installation Options

#### Option 1: Using npx (Recommended)

The easiest way to use CodeCritique - no installation required:

```bash
npx codecritique analyze --file path/to/file.py
```

View the package on npm: [https://www.npmjs.com/package/codecritique](https://www.npmjs.com/package/codecritique)

#### Option 2: Global Installation

For frequent use, install globally:

```bash
npm install -g codecritique
codecritique analyze --file path/to/file.py
```

#### Option 3: Run from Source

For development or contributing:

1. **Clone the repository**:

   ```bash
   git clone https://github.com/cosmocoder/CodeCritique.git
   cd CodeCritique
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Run the tool**:

   ```bash
   # Analyze a single file
   node src/index.js analyze --file path/to/file.py

   # Or use npm script (if available)
   npm start analyze --file path/to/file.py
   ```

   **Method B: Using Shell Script Wrapper (Recommended for non-JS projects)**

For easier integration with non-JavaScript projects, you can use the provided shell script wrapper:

1. **Copy the wrapper script** to your project:

   ```bash
   # From the CodeCritique repository
   cp src/codecritique.sh /path/to/your/project/codecritique.sh
   chmod +x /path/to/your/project/codecritique.sh
   ```

2. **Use the wrapper** (automatically handles environment setup):

   ```bash
   # The script will automatically:
   # - Check for Node.js installation
   # - Load .env file if present
   # - Verify ANTHROPIC_API_KEY
   # - Try global installation first, then fall back to npx

   ./codecritique.sh analyze --file path/to/file.py
   ./codecritique.sh embeddings:generate --directory src
   ```

3. **Environment setup** (the script handles this automatically):
   - Creates/uses `.env` file in your project directory
   - Validates Node.js v22.14.0+ requirement
   - Provides helpful error messages for missing dependencies

## Quick Start

Follow this three-step workflow for optimal code review results:

### Step 1: Generate Embeddings (Required)

**Generate embeddings for your codebase first** - this is essential for context-aware analysis:

```bash
# Generate embeddings for current directory
npx codecritique embeddings:generate --directory src

# Generate for specific files or patterns
npx codecritique embeddings:generate --files "src/**/*.ts" "lib/*.js"

# Generate with exclusions (recommended for large codebases)
npx codecritique embeddings:generate --directory src --exclude "**/*.test.js" "**/*.spec.js"
```

### Step 2: Analyze PR History (Optional)

**Enhance reviews with historical context** by analyzing past PR comments. This step requires a GitHub token:

#### Prerequisites for PR History Analysis

You must set a `GITHUB_TOKEN` environment variable with repository access permissions:

```bash
# Set GitHub token (required for PR history analysis)
export GITHUB_TOKEN=your_github_token_here

# Or add to .env file
echo "GITHUB_TOKEN=your_github_token_here" >> .env
```

#### Run PR History Analysis

```bash
# Analyze PR history for current project (auto-detects GitHub repo)
npx codecritique pr-history:analyze

# Analyze specific repository
npx codecritique pr-history:analyze --repository owner/repo

# Analyze with date range
npx codecritique pr-history:analyze --since 2024-01-01 --until 2024-12-31
```

### Step 3: Analyze Code (Final Step)

**Now perform the actual code review** with rich context from embeddings and PR history:

#### Basic Analysis

```bash
# Analyze a single file
npx codecritique analyze --file src/components/Button.tsx

# Analyze files matching patterns
npx codecritique analyze --files "src/**/*.ts" "lib/*.js"

# Analyze changes in feature-branch vs main branch (auto-detects base branch)
npx codecritique analyze --diff-with feature-branch
```

#### Using with Custom Guidelines

```bash
# Include your team's coding standards
npx codecritique analyze \
  --file src/utils/validation.ts \
  --doc "Engineering Guidelines:./docs/guidelines.md" \
  --doc "API Standards:./docs/api-standards.md"
```

#### Non-JavaScript Projects

```bash
# Python project
cd /path/to/python/project
npx codecritique analyze --file app.py

# Ruby project
npx codecritique analyze --files "**/*.rb"

# Any language with git diff
npx codecritique analyze --diff-with feature-branch
```

## GitHub Actions Integration

This project provides **two reusable GitHub Actions** that can be used in any repository for automated AI-powered code review:

1. **🧠 Generate Embeddings Action** - Creates semantic embeddings for your codebase
2. **🔍 PR Review Action** - Performs AI-powered code reviews on pull requests

These actions can be used independently or together for a complete AI code review workflow in your CI/CD pipeline.

---

### 🧠 Generate Embeddings Action

**Action Path:** `cosmocoder/CodeCritique/.github/actions/generate-embeddings@main`

This action generates semantic embeddings for your codebase, enabling context-aware code analysis. The embeddings are stored as GitHub Actions artifacts and can be reused across workflow runs. It is recommended to generated embeddings for your project every time the `main` branch is updated.

#### Basic Usage

```yaml
name: Generate Code Embeddings

on:
  push:
    branches:
      - main

jobs:
  generate-embeddings:
    name: Generate Code Embeddings
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read # needed for downloading artifacts

    steps:
      - name: Checkout Target Repository
        uses: actions/checkout@v4

      - name: Generate Embeddings
        uses: cosmocoder/CodeCritique/.github/actions/generate-embeddings@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          verbose: true
```

#### Input Parameters

| Parameter                   | Description                                             | Required | Default          |
| --------------------------- | ------------------------------------------------------- | -------- | ---------------- |
| `anthropic-api-key`         | Anthropic API key for Claude models                     | **Yes**  | -                |
| `files`                     | Specific files or patterns to process (space-separated) | No       | `''` (all files) |
| `concurrency`               | Number of concurrent embedding requests                 | No       | Auto-detected    |
| `exclude`                   | Patterns to exclude (space-separated glob patterns)     | No       | `''`             |
| `exclude-file`              | File containing patterns to exclude (one per line)      | No       | `''`             |
| `verbose`                   | Show verbose output                                     | No       | `false`          |
| `embeddings-retention-days` | Number of days to retain embedding artifacts            | No       | `30`             |

> **See [GitHub Actions Advanced Configuration](docs/GITHUB_ACTIONS.md)** for processing specific files, high performance setup, and more examples.

---

### 🔍 PR Review Action

**Action Path:** `cosmocoder/CodeCritique/.github/actions/pr-review@main`

This action performs AI-powered code reviews on pull requests using Anthropic Claude models. It automatically downloads any available embeddings to provide context-aware analysis and posts review comments directly to the PR.

The action includes intelligent feedback tracking that monitors user reactions and replies to review comments. When users dismiss suggestions (through reactions like 👎 or replies with keywords like "disagree", "ignore", or "not relevant"), the action automatically resolves those conversation threads and avoids reposting similar issues in subsequent runs on the same PR, creating a more streamlined review experience.

#### Basic Usage

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  pr-review:
    name: AI PR Review
    runs-on: ubuntu-latest
    permissions:
      contents: write # needed for marking conversations as resolved
      pull-requests: write # needed for posting comments
      actions: read # needed for downloading artifacts

    steps:
      - name: ⬇️ Checkout repo
        uses: actions/checkout@v4

      - name: Setup master branch for diff analysis
        run: git fetch --no-tags --prune origin main:main

      - name: Code Review
        uses: cosmocoder/CodeCritique/.github/actions/pr-review@main
        with:
          verbose: true
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

#### Required Setup

1. **Anthropic API Key**: Store your Anthropic API key as a repository secret named `ANTHROPIC_API_KEY`
2. **Permissions**: The workflow must have `contents: write`, `actions: read`, and `pull-requests: write` permissions
3. **Git Setup**: Ensure the base branch is available for diff analysis (see example above)

#### Input Parameters

| Parameter           | Description                                                                                              | Required | Default              |
| ------------------- | -------------------------------------------------------------------------------------------------------- | -------- | -------------------- |
| `anthropic-api-key` | Anthropic API key for Claude models                                                                      | **Yes**  | -                    |
| `skip-label`        | Label name to skip AI review                                                                             | No       | `ai-review-disabled` |
| `verbose`           | Show verbose output                                                                                      | No       | `false`              |
| `model`             | LLM model to use (e.g., `claude-sonnet-4-5`)                                                             | No       | Auto-selected        |
| `max-tokens`        | Maximum tokens for LLM response                                                                          | No       | Auto-calculated      |
| `cache-ttl`         | Cache TTL for LLM prompts: "5m" (default, no extra cost) or "1h" (extended, extra cost for cache writes) | No       | `5m`                 |
| `concurrency`       | Concurrency for processing multiple files                                                                | No       | `3`                  |
| `custom-docs`       | Custom documents (format: `"title:path,title:path"`)                                                     | No       | `''`                 |

> **Note**: The action uses sensible defaults for all review parameters. It always:
>
> - Uses JSON output format for parsing results
> - Posts both individual comments and summary comments to PRs
> - Limits to 25 comments maximum
> - Tracks feedback to improve future reviews
> - Uses optimal temperature and similarity thresholds

> **See [GitHub Actions Advanced Configuration](docs/GITHUB_ACTIONS.md)** for output values, skipping reviews with labels, custom model settings, and more.

---

## Commands Reference

CodeCritique provides commands for code analysis, embedding management, and PR history analysis.

### Core Commands

| Command                | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `analyze`              | Analyze code using RAG with context retrieval          |
| `embeddings:generate`  | Generate embeddings for your codebase                  |
| `embeddings:stats`     | Show statistics about stored embeddings                |
| `embeddings:clear`     | Clear embeddings for current project                   |
| `embeddings:clear-all` | Clear ALL embeddings (all projects - use with caution) |
| `pr-history:analyze`   | Analyze PR comment history                             |
| `pr-history:status`    | Check PR analysis status                               |
| `pr-history:clear`     | Clear PR analysis data                                 |

### Quick Examples

```bash
# Analyze a single file
codecritique analyze --file src/components/Button.tsx

# Analyze files matching patterns
codecritique analyze --files "src/**/*.ts" "lib/*.js"

# Analyze branch diff
codecritique analyze --diff-with feature-branch

# Generate embeddings
codecritique embeddings:generate --directory src

# Analyze PR history
codecritique pr-history:analyze --repository owner/repo
```

> **See [Commands Reference](docs/COMMANDS.md)** for complete documentation of all commands, options, and examples.

---

## RAG Architecture

CodeCritique uses **Retrieval-Augmented Generation (RAG)** to provide context-aware code analysis. Instead of generic static analysis, it retrieves relevant context from your codebase (similar code examples, documentation, PR history) and provides this to the LLM for more accurate, project-specific reviews.

Key components include local embeddings via FastEmbed, vector storage with LanceDB, and LLM analysis with Anthropic Claude.

> **See [Architecture Documentation](docs/ARCHITECTURE.md)** for detailed diagrams, component descriptions, and benefits.

---

## Configuration

### Custom Documents

Integrate your team's guidelines and documentation:

```bash
codecritique analyze --file src/component.tsx \
  --doc "Engineering Guidelines:./docs/engineering.md" \
  --doc "React Standards:./docs/react-guide.md" \
  --doc "API Guidelines:./docs/api-standards.md"
```

Document format: `"Title:./path/to/file.md"`

### Embedding Exclusions

#### Using exclusion files

Create a file containing exclusion patterns (one per line) and reference it with `--exclude-file`:

```
# Example: exclusion-patterns.txt
# Exclude test files
**/*.test.js
**/*.spec.js
**/*.test.ts
**/*.spec.ts

# Exclude build outputs
dist/
build/
*.min.js

# Exclude dependencies
node_modules/
vendor/
```

#### Using command-line exclusions

```bash
codecritique embeddings:generate \
  --exclude "**/*.test.js" "dist/**" "node_modules/**"
```

### Environment Variables

```env
# Required
ANTHROPIC_API_KEY=your_anthropic_api_key

# Optional for PR history analysis
GITHUB_TOKEN=your_github_token

# Optional debugging
DEBUG=true
VERBOSE=true
```

## Output Formats

CodeCritique supports three output formats:

- **Text** (default) - Human-readable colored output for terminal usage
- **JSON** - Structured output for programmatic processing
- **Markdown** - Documentation-friendly format

```bash
codecritique analyze --file src/app.ts --output json
codecritique analyze --file src/app.ts --output markdown
```

> **See [Output Formats](docs/OUTPUT_FORMATS.md)** for detailed examples of each format.

---

If you encounter issues, see the **[Troubleshooting Guide](docs/TROUBLESHOOTING.md)** for solutions to common problems including API key issues, memory errors, and performance optimization tips.

For quick debugging, use verbose mode:

```bash
codecritique analyze --file app.py --verbose
```

---

## Contributing

We welcome contributions! Please see our [CONTRIBUTING.md](CONTRIBUTING.md) guide for:

- Development setup instructions
- Code style guidelines
- Commit conventions (for semantic versioning)
- Testing guidelines
- Pull request process

## Acknowledgements

This project is built with these amazing technologies:

- **[FastEmbed](https://github.com/qdrant/fastembed)** - Fast, lightweight embedding generation
- **[Hugging Face Transformers.js](https://github.com/huggingface/transformers.js)** - Machine learning for the web
- **[LanceDB](https://lancedb.com/)** - High-performance vector database for embeddings
- **[Commander.js](https://github.com/tj/commander.js)** - CLI framework for Node.js
- **[Octokit](https://github.com/octokit/rest.js)** - GitHub API client for PR history analysis
- **[Anthropic Claude](https://www.anthropic.com/)** - LLM powering intelligent code analysis

## License

MIT License - see [LICENSE](LICENSE) file for details.
