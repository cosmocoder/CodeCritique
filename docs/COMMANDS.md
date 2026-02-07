# Commands Reference

## analyze

Analyze code using RAG (Retrieval-Augmented Generation) approach with dynamic context retrieval.

```bash
codecritique analyze [options]
```

### Options

| Option                            | Description                                                                                              | Default       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| `-b, --diff-with <branch>`        | Analyze files changed in the specified branch compared to the base branch (main/master)                  | -             |
| `-f, --files <files...>`          | Specific files or glob patterns to review                                                                | -             |
| `--file <file>`                   | Analyze a single file                                                                                    | -             |
| `-d, --directory <dir>`           | Working directory for git operations (use with --diff-with)                                              | -             |
| `-o, --output <format>`           | Output format (text, json, markdown)                                                                     | `text`        |
| `--output-file <file>`            | Save output to file (useful with --output json)                                                          | -             |
| `--no-color`                      | Disable colored output                                                                                   | `false`       |
| `--verbose`                       | Show verbose output                                                                                      | `false`       |
| `--model <model>`                 | LLM model to use (e.g., claude-sonnet-4-5)                                                               | Auto-selected |
| `--temperature <number>`          | LLM temperature                                                                                          | `0.2`         |
| `--max-tokens <number>`           | LLM max tokens                                                                                           | `8192`        |
| `--similarity-threshold <number>` | Threshold for finding similar code examples                                                              | `0.6`         |
| `--max-examples <number>`         | Max similar code examples to use                                                                         | `5`           |
| `--concurrency <number>`          | Concurrency for processing multiple files                                                                | `3`           |
| `--doc <specs...>`                | Custom documents to provide to LLM (format: "Title:./path/to/file.md"). Can be specified multiple times. | -             |
| `--feedback-path <path>`          | Path to feedback artifacts directory for filtering dismissed issues                                      | -             |
| `--track-feedback`                | Enable feedback-aware analysis to avoid previously dismissed issues                                      | `false`       |
| `--feedback-threshold <number>`   | Similarity threshold for feedback filtering (0-1)                                                        | `0.7`         |

### Examples

```bash
# Analyze a single file
codecritique analyze --file src/components/Button.tsx

# Analyze multiple files with patterns
codecritique analyze --files "src/**/*.tsx" "lib/*.js"

# Analyze changes in feature-branch vs main branch (auto-detects base branch)
codecritique analyze --diff-with feature-branch

# Analyze with custom documentation
codecritique analyze --file src/utils/validation.ts \
  --doc "Engineering Guidelines:./docs/guidelines.md"

# Analyze with custom LLM settings
codecritique analyze --file app.py \
  --temperature 0.1 \
  --max-tokens 4096 \
  --similarity-threshold 0.7

# Analyze changes in specific directory
codecritique analyze --diff-with feature-branch --directory /path/to/repo

# Output as JSON
codecritique analyze --files "src/**/*.ts" --output json > review.json

# Save JSON output directly to a file
codecritique analyze --files "src/**/*.ts" --output json --output-file review.json

# Analyze with feedback tracking (avoids repeating dismissed issues)
codecritique analyze --diff-with feature-branch --track-feedback --feedback-path ./feedback-artifacts
```

## embeddings:generate

Generate embeddings for the codebase to enable context-aware analysis.

```bash
codecritique embeddings:generate [options]
```

### Options

| Option                       | Description                                                                    | Default |
| ---------------------------- | ------------------------------------------------------------------------------ | ------- |
| `-d, --directory <dir>`      | Directory to process                                                           | `.`     |
| `-f, --files <files...>`     | Specific files or patterns to process                                          | -       |
| `-c, --concurrency <number>` | Number of concurrent embedding requests                                        | `10`    |
| `--verbose`                  | Show verbose output                                                            | `false` |
| `--exclude <patterns...>`    | Patterns to exclude (e.g., "**/\*.test.js" "docs/**")                          | -       |
| `--exclude-file <file>`      | File containing patterns to exclude (one per line)                             | -       |
| `--no-gitignore`             | Disable automatic exclusion of files in .gitignore                             | `false` |
| `--max-lines`                | Maximum lines per code file that will be considered when generating embeddings | `1000`  |
| `--force-analysis`           | Force regeneration of project analysis summary (bypasses cache)                | `false` |

### Examples

```bash
# Generate embeddings for current directory
codecritique embeddings:generate

# Generate for specific directory
codecritique embeddings:generate --directory src

# Generate for specific files
codecritique embeddings:generate --files "src/**/*.tsx" "lib/*.js"

# Exclude test files and docs
codecritique embeddings:generate --exclude "**/*.test.js" "**/*.spec.js" "docs/**"

# Use exclusion file
codecritique embeddings:generate --exclude-file exclusion-patterns.txt

# Process without gitignore exclusions
codecritique embeddings:generate --no-gitignore

# High concurrency for large codebases
codecritique embeddings:generate --concurrency 20 --verbose

# Force regeneration of project analysis (useful after major codebase changes)
codecritique embeddings:generate --force-analysis --verbose

# Combine force analysis with specific directory processing
codecritique embeddings:generate --directory src --force-analysis
```

## embeddings:stats

Show statistics about stored embeddings.

```bash
codecritique embeddings:stats [options]
```

### Options

| Option                  | Description                                                                      | Default |
| ----------------------- | -------------------------------------------------------------------------------- | ------- |
| `-d, --directory <dir>` | Directory of the project to show stats for (shows all projects if not specified) | -       |

### Examples

```bash
# Show stats for all projects
codecritique embeddings:stats

# Show stats for specific project
codecritique embeddings:stats --directory /path/to/project
```

## embeddings:clear

Clear stored embeddings for the current project.

```bash
codecritique embeddings:clear [options]
```

### Options

| Option                  | Description                                      | Default |
| ----------------------- | ------------------------------------------------ | ------- |
| `-d, --directory <dir>` | Directory of the project to clear embeddings for | `.`     |

### Examples

```bash
# Clear embeddings for current project
codecritique embeddings:clear

# Clear embeddings for specific project
codecritique embeddings:clear --directory /path/to/project
```

## embeddings:clear-all

Clear ALL stored embeddings (affects all projects - use with caution).

```bash
codecritique embeddings:clear-all
```

**Warning**: This command clears embeddings for all projects on the machine.

## pr-history:analyze

Analyze PR comment history for the current project or specified repository.

```bash
codecritique pr-history:analyze [options]
```

### Options

| Option                    | Description                                                         | Default |
| ------------------------- | ------------------------------------------------------------------- | ------- |
| `-d, --directory <dir>`   | Project directory to analyze (auto-detects GitHub repo)             | `.`     |
| `-r, --repository <repo>` | GitHub repository in format "owner/repo" (overrides auto-detection) | -       |
| `-t, --token <token>`     | GitHub API token (or set GITHUB_TOKEN env var)                      | -       |
| `--since <date>`          | Only analyze PRs since this date (ISO format)                       | -       |
| `--until <date>`          | Only analyze PRs until this date (ISO format)                       | -       |
| `--limit <number>`        | Limit number of PRs to analyze                                      | -       |
| `--resume`                | Resume interrupted analysis                                         | `false` |
| `--clear`                 | Clear existing data before analysis                                 | `false` |
| `--concurrency <number>`  | Number of concurrent requests                                       | `2`     |
| `--batch-size <number>`   | Batch size for processing                                           | `50`    |
| `--verbose`               | Show verbose output                                                 | `false` |

### Examples

```bash
# Analyze current project (auto-detect repo)
codecritique pr-history:analyze

# Analyze specific repository
codecritique pr-history:analyze --repository owner/repo --token ghp_xxx

# Analyze with date range
codecritique pr-history:analyze --since 2024-01-01 --until 2024-12-31

# Clear existing data and re-analyze
codecritique pr-history:analyze --clear --limit 100

# Resume interrupted analysis
codecritique pr-history:analyze --resume
```

## pr-history:status

Check PR analysis status for the current project or specified repository.

```bash
codecritique pr-history:status [options]
```

### Options

| Option                    | Description                                                         | Default |
| ------------------------- | ------------------------------------------------------------------- | ------- |
| `-d, --directory <dir>`   | Project directory to check status for                               | `.`     |
| `-r, --repository <repo>` | GitHub repository in format "owner/repo" (overrides auto-detection) | -       |

### Examples

```bash
# Check status for current project
codecritique pr-history:status

# Check status for specific repository
codecritique pr-history:status --repository owner/repo
```

## pr-history:clear

Clear PR analysis data for the current project or specified repository.

```bash
codecritique pr-history:clear [options]
```

### Options

| Option                    | Description                                                         | Default |
| ------------------------- | ------------------------------------------------------------------- | ------- |
| `-d, --directory <dir>`   | Project directory to clear data for                                 | `.`     |
| `-r, --repository <repo>` | GitHub repository in format "owner/repo" (overrides auto-detection) | -       |
| `--force`                 | Skip confirmation prompts                                           | `false` |

### Examples

```bash
# Clear data for current project (with confirmation)
codecritique pr-history:clear

# Clear data for specific repository without confirmation
codecritique pr-history:clear --repository owner/repo --force
```

---

For more information, see the [main README](../README.md).
