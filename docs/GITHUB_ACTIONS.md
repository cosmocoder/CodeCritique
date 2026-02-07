# GitHub Actions - Advanced Configuration

This document contains advanced configuration options and full reference material for the CodeCritique GitHub Actions. For basic usage and quick start examples, see the [main README](../README.md).

The CodeCritique project provides two reusable GitHub Actions that can be integrated into any repository's CI/CD pipeline:

1. **Generate Embeddings Action** - Creates semantic embeddings for your codebase
2. **PR Review Action** - Performs AI-powered code reviews on pull requests

These actions work together to provide context-aware code analysis, but can also be used independently based on your needs.

---

## Generate Embeddings Action - Full Reference

**Action Path:** `cosmocoder/CodeCritique/.github/actions/generate-embeddings@main`

This action generates semantic embeddings for your codebase using FastEmbed, enabling context-aware code analysis. The embeddings are stored as GitHub Actions artifacts and can be reused across workflow runs. It is recommended to generate embeddings whenever your `main` branch is updated.

### Complete Input Parameters

| Parameter                   | Description                                             | Required | Default          |
| --------------------------- | ------------------------------------------------------- | -------- | ---------------- |
| `anthropic-api-key`         | Anthropic API key for Claude models                     | **Yes**  | -                |
| `files`                     | Specific files or patterns to process (space-separated) | No       | `''` (all files) |
| `concurrency`               | Number of concurrent embedding requests                 | No       | Auto-detected    |
| `exclude`                   | Patterns to exclude (space-separated glob patterns)     | No       | `''`             |
| `exclude-file`              | File containing patterns to exclude (one per line)      | No       | `''`             |
| `verbose`                   | Show verbose output                                     | No       | `false`          |
| `embeddings-retention-days` | Number of days to retain embedding artifacts            | No       | `30`             |

### Advanced Configuration Examples

#### Processing Specific Files

Process only TypeScript files while excluding test files:

```yaml
name: Generate TypeScript Embeddings

on:
  push:
    branches:
      - main

jobs:
  generate-embeddings:
    name: Generate TypeScript Embeddings
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Generate Embeddings for TypeScript Files
        uses: cosmocoder/CodeCritique/.github/actions/generate-embeddings@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          files: 'src/**/*.ts src/**/*.tsx'
          exclude: '**/*.test.ts **/*.spec.ts **/*.test.tsx **/*.spec.tsx'
          verbose: true
```

#### High Performance Setup

Optimize for large codebases with high concurrency and longer artifact retention:

```yaml
name: Generate Embeddings (High Performance)

on:
  push:
    branches:
      - main

jobs:
  generate-embeddings:
    name: Generate Embeddings (High Performance)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Generate Embeddings (High Performance)
        uses: cosmocoder/CodeCritique/.github/actions/generate-embeddings@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          concurrency: 20
          embeddings-retention-days: 60
          exclude: '**/*.test.* **/*.spec.* dist/** build/** node_modules/**'
          verbose: true
```

#### Using Exclusion Files

For complex exclusion patterns, use an exclusion file:

```yaml
name: Generate Embeddings with Exclusion File

on:
  push:
    branches:
      - main

jobs:
  generate-embeddings:
    name: Generate Embeddings
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Generate Embeddings
        uses: cosmocoder/CodeCritique/.github/actions/generate-embeddings@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          exclude-file: '.codecritique-exclude'
          verbose: true
```

Where `.codecritique-exclude` contains:

```
# Test files
**/*.test.js
**/*.test.ts
**/*.spec.js
**/*.spec.ts

# Build outputs
dist/
build/
*.min.js

# Dependencies
node_modules/
vendor/
```

---

## PR Review Action - Full Reference

**Action Path:** `cosmocoder/CodeCritique/.github/actions/pr-review@main`

This action performs AI-powered code reviews on pull requests using Anthropic Claude models. It automatically downloads any available embeddings to provide context-aware analysis and posts review comments directly to the PR.

The action includes intelligent feedback tracking that monitors user reactions and replies to review comments. When users dismiss suggestions (through reactions like 👎 or replies with keywords like "disagree", "ignore", or "not relevant"), the action automatically resolves those conversation threads and avoids reposting similar issues in subsequent runs on the same PR.

### Complete Input Parameters

| Parameter           | Description                                          | Required | Default              |
| ------------------- | ---------------------------------------------------- | -------- | -------------------- |
| `anthropic-api-key` | Anthropic API key for Claude models                  | **Yes**  | -                    |
| `skip-label`        | Label name to skip AI review                         | No       | `ai-review-disabled` |
| `verbose`           | Show verbose output                                  | No       | `false`              |
| `model`             | LLM model to use                                     | No       | Auto-selected        |
| `max-tokens`        | Maximum tokens for LLM response                      | No       | Auto-calculated      |
| `concurrency`       | Concurrency for processing multiple files            | No       | `3`                  |
| `custom-docs`       | Custom documents (format: `"title:path,title:path"`) | No       | `''`                 |

### Output Values

The action provides several outputs that can be used in subsequent workflow steps:

| Output                       | Description                            |
| ---------------------------- | -------------------------------------- |
| `comments-posted`            | Number of review comments posted       |
| `issues-found`               | Total number of issues found           |
| `files-analyzed`             | Number of files analyzed               |
| `embedding-cache-hit`        | Whether embeddings were found and used |
| `review-score`               | Overall review score (0-100)           |
| `security-issues`            | Number of security issues found        |
| `performance-issues`         | Number of performance issues found     |
| `maintainability-issues`     | Number of maintainability issues found |
| `feedback-artifact-uploaded` | Whether feedback artifact was uploaded |
| `review-report-path`         | Path to the detailed review report     |

### Advanced Configuration Examples

#### Skipping Reviews with Labels

You can skip AI reviews for specific PRs by adding a label. This is useful when:

- You want to merge urgent hotfixes without waiting for AI review
- The PR contains only documentation or configuration changes
- You're making experimental changes that don't need review
- You've already reviewed the code manually and don't need AI feedback

By default, the action checks for the `ai-review-disabled` label, but you can customize this:

```yaml
name: AI PR Review (Custom Skip Label)

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  pr-review:
    name: AI PR Review
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Base Branch for Diff Analysis
        run: git fetch --no-tags --prune origin main:main

      - name: AI Code Review (Customizable Skip)
        uses: cosmocoder/CodeCritique/.github/actions/pr-review@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          skip-label: 'no-ai-review' # Custom label name
          verbose: true
```

When a PR has the skip label, the workflow will exit early with a message:

```
⏭️  Skipping AI review - PR has 'no-ai-review' label
```

To use this feature:

1. Create a label in your repository (e.g., `no-ai-review` or `ai-review-disabled`)
2. Add the label to any PR you want to skip
3. The action will automatically detect it and skip the review

#### Custom Model and Performance Settings

Configure the LLM model and performance parameters for your specific needs:

```yaml
name: AI PR Review (Custom Settings)

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  pr-review:
    name: AI PR Review
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Base Branch for Diff Analysis
        run: git fetch --no-tags --prune origin main:main

      - name: AI Code Review with Custom Settings
        id: review
        uses: cosmocoder/CodeCritique/.github/actions/pr-review@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: 'claude-3-5-sonnet-20241022'
          max-tokens: '4000'
          concurrency: '5'
          verbose: true

      - name: Display Review Metrics
        run: |
          echo "Files analyzed: ${{ steps.review.outputs.files-analyzed }}"
          echo "Issues found: ${{ steps.review.outputs.issues-found }}"
          echo "Review score: ${{ steps.review.outputs.review-score }}"
          echo "Security issues: ${{ steps.review.outputs.security-issues }}"
          echo "Performance issues: ${{ steps.review.outputs.performance-issues }}"
          echo "Maintainability issues: ${{ steps.review.outputs.maintainability-issues }}"
```

#### With Custom Documentation

Integrate your team's coding standards and guidelines:

```yaml
name: AI PR Review (With Team Guidelines)

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  pr-review:
    name: AI PR Review
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Base Branch for Diff Analysis
        run: git fetch --no-tags --prune origin main:main

      - name: AI Code Review with Team Guidelines
        uses: cosmocoder/CodeCritique/.github/actions/pr-review@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          custom-docs: 'Style Guide:./docs/style-guide.md,API Standards:./docs/api-standards.md,Engineering Guidelines:./docs/engineering.md'
          verbose: true
```

The `custom-docs` parameter accepts multiple documents in the format `"title:path,title:path"`. Each document should be:

- A markdown file containing your team's guidelines
- Accessible from the repository root
- Properly formatted for LLM consumption

#### Using Output Values in Conditional Steps

Use the action outputs to conditionally run subsequent steps:

```yaml
name: AI PR Review (Conditional Workflow)

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  pr-review:
    name: AI PR Review
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Base Branch for Diff Analysis
        run: git fetch --no-tags --prune origin main:main

      - name: AI Code Review
        id: review
        uses: cosmocoder/CodeCritique/.github/actions/pr-review@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          verbose: true

      - name: Check for Critical Issues
        if: steps.review.outputs.security-issues > 0
        run: |
          echo "⚠️ Critical: Found ${{ steps.review.outputs.security-issues }} security issues"
          # Add custom logic here, e.g., block merge, notify team, etc.

      - name: Upload Review Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: review-report
          path: ${{ steps.review.outputs.review-report-path }}
          retention-days: 30
```

#### Complete Workflow Example

A complete workflow that combines both actions:

```yaml
name: CodeCritique CI

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  generate-embeddings:
    name: Generate Embeddings
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Generate Embeddings
        uses: cosmocoder/CodeCritique/.github/actions/generate-embeddings@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          exclude: '**/*.test.* **/*.spec.* dist/** build/**'
          embeddings-retention-days: 60
          verbose: true

  pr-review:
    name: AI PR Review
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: read

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Base Branch for Diff Analysis
        run: git fetch --no-tags --prune origin main:main

      - name: AI Code Review
        id: review
        uses: cosmocoder/CodeCritique/.github/actions/pr-review@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          custom-docs: 'Engineering Guidelines:./docs/ENGINEERING_GUIDELINES.md'
          verbose: true

      - name: Review Summary
        run: |
          echo "## Code Review Summary" >> $GITHUB_STEP_SUMMARY
          echo "- Files analyzed: ${{ steps.review.outputs.files-analyzed }}" >> $GITHUB_STEP_SUMMARY
          echo "- Issues found: ${{ steps.review.outputs.issues-found }}" >> $GITHUB_STEP_SUMMARY
          echo "- Review score: ${{ steps.review.outputs.review-score }}/100" >> $GITHUB_STEP_SUMMARY
```

---

## Best Practices

1. **Generate embeddings on main branch updates**: Keep your embeddings up-to-date by running the generate-embeddings action whenever code is merged to main.

2. **Use appropriate exclusions**: Exclude test files, build outputs, and dependencies to reduce embedding generation time and improve relevance.

3. **Set appropriate retention periods**: Balance artifact storage costs with convenience. Longer retention (60+ days) is useful for stable codebases.

4. **Customize skip labels**: Use meaningful label names that match your team's workflow conventions.

5. **Leverage custom documentation**: Include your team's coding standards, API guidelines, and best practices for more relevant reviews.

6. **Monitor review metrics**: Use output values to track review quality and identify areas for improvement.

7. **Combine with other checks**: Use review outputs to conditionally run additional checks or block merges for critical issues.

---

For basic usage examples and quick start guides, see the [main README](../README.md).
