# Output Formats

CodeCritique supports three output formats to suit different use cases: **text** (default), **json**, and **markdown**. Each format is designed for specific scenarios, from interactive terminal usage to programmatic processing and documentation generation.

## Severity Levels

CodeCritique uses the following severity levels for issues:

| Severity   | Emoji | Description                                   |
| ---------- | ----- | --------------------------------------------- |
| `critical` | 🚨    | Critical issues requiring immediate attention |
| `high`     | 🔥    | High priority issues                          |
| `medium`   | ⚠️    | Medium priority issues                        |
| `low`      | 💡    | Low priority suggestions                      |
| `info`     | ℹ️    | Informational notes                           |

## Text Format (Default)

The text format provides human-readable colored output optimized for terminal usage. It's the default format and is ideal for interactive code reviews where you want to quickly scan results.

**Example:**

```
===== AI Code Review Summary =====
Files Analyzed: 3
Files with Issues: 2
Total Issues Found: 5

===== Review for src/components/Button.tsx =====
Summary: Component has naming inconsistency and missing prop validation

Issues:
  [HIGH] (Lines: 5)
    Component name 'ButtonComponent' doesn't match filename 'Button'
    Suggestion: Rename component to 'Button' or update file name

  [LOW] (Lines: 12-15)
    Missing prop type validation
    Suggestion: Add PropTypes or TypeScript interface
    Code Suggestion (lines 12-15):
    Old:
      const Button = (props) => {
    New:
      interface ButtonProps { onClick?: () => void; disabled?: boolean; }
      const Button = (props: ButtonProps) => {

Positives:
  - Good use of semantic HTML elements
  - Proper accessibility attributes
```

## JSON Format

The JSON format provides structured output perfect for programmatic processing, CI/CD integration, and automated workflows. It includes comprehensive metadata and can be easily parsed by scripts and tools.

**Example:**

```json
{
  "summary": {
    "totalFilesReviewed": 3,
    "filesWithIssues": 2,
    "totalIssues": 5,
    "issuesWithCodeSuggestions": 1,
    "skippedFiles": 0,
    "errorFiles": 0
  },
  "details": [
    {
      "filePath": "src/components/Button.tsx",
      "success": true,
      "language": "typescript",
      "review": {
        "summary": "Component has naming inconsistency and missing prop validation",
        "issues": [
          {
            "severity": "high",
            "description": "Component name 'ButtonComponent' doesn't match filename 'Button'",
            "lineNumbers": [5],
            "suggestion": "Rename component to 'Button' or update file name"
          },
          {
            "severity": "low",
            "description": "Missing prop type validation",
            "lineNumbers": [12, 13, 14, 15],
            "suggestion": "Add TypeScript interface for props",
            "codeSuggestion": {
              "startLine": 12,
              "endLine": 15,
              "oldCode": "const Button = (props) => {",
              "newCode": "interface ButtonProps { onClick?: () => void; disabled?: boolean; }\nconst Button = (props: ButtonProps) => {"
            }
          }
        ],
        "positives": ["Good use of semantic HTML elements", "Proper accessibility attributes"]
      }
    }
  ]
}
```

### JSON Summary Fields

| Field                       | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `totalFilesReviewed`        | Number of files analyzed                                 |
| `filesWithIssues`           | Number of files that have at least one issue             |
| `totalIssues`               | Total count of all issues found                          |
| `issuesWithCodeSuggestions` | Number of issues that include code fix suggestions       |
| `skippedFiles`              | Number of files skipped (due to exclusions or file type) |
| `errorFiles`                | Number of files that failed to analyze                   |

## Markdown Format

The markdown format is documentation-friendly and ideal for generating reports, sharing results in documentation, or integrating with markdown-based tools. It uses standard markdown syntax with clear headings and formatting.

**Example:**

````markdown
# AI Code Review Results (RAG Approach)

## Summary

- **Files Analyzed:** 3
- **Files with Issues:** 2
- **Total Issues Found:** 5

## Detailed Review per File

### src/components/Button.tsx

**Summary:** Component has naming inconsistency and missing prop validation

**Issues Found (2):**

- **[HIGH] 🔥 (Lines: 5)**: Component name 'ButtonComponent' doesn't match filename 'Button'

  _Suggestion:_ Rename component to 'Button' or update file name

- **[LOW] 💡 (Lines: 12, 13, 14, 15)**: Missing prop type validation

  _Suggestion:_ Add TypeScript interface for props

  **Suggested change (lines 12-15):**

  ```suggestion
  interface ButtonProps { onClick?: () => void; disabled?: boolean; }
  const Button = (props: ButtonProps) => {
  ```
````

**Positives Found (2):**

- Good use of semantic HTML elements

- Proper accessibility attributes

````

## Usage

Specify the output format using the `--output` (or `-o`) option:

```bash
# Text format (default)
codecritique analyze --file src/app.ts --output text

# JSON format
codecritique analyze --file src/app.ts --output json

# Markdown format
codecritique analyze --file src/app.ts --output markdown
````

### Saving Output to a File

You can redirect output to a file using shell redirection:

```bash
codecritique analyze --files "src/**/*.ts" --output json > review.json
```

Or use the `--output-file` option (for JSON format):

```bash
codecritique analyze --files "src/**/*.ts" --output json --output-file review.json
```

---

For more information about CodeCritique, see the [main README](../README.md).
