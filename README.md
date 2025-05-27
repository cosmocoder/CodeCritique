# AI Code Review Tool

A self-hosted, AI-powered code review tool designed to enhance your development workflow with automated, context-aware code reviews using FastEmbed for local embeddings and Anthropic Claude for analysis. While originally built for JavaScript and TypeScript projects, it can be used with any programming language.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Customization](#customization)
- [API Requirements](#api-requirements)
- [Future Development](#future-development)

## Overview

### Purpose and Benefits

The AI Code Review Tool is a powerful solution that leverages AI to provide automated, context-aware code reviews for any programming language. While it has specialized support for JavaScript and TypeScript, it can analyze code changes, apply project-specific rules, and provide actionable feedback to improve code quality in projects written in Python, Ruby, Java, C++, and more.

Key benefits include:

- **Reduced Review Time**: Automate repetitive aspects of code review, allowing developers to focus on higher-level concerns
- **Consistent Standards**: Enforce coding standards and best practices uniformly across the codebase
- **Context-Aware Analysis**: Leverage embeddings to understand your codebase's specific patterns and conventions
- **Actionable Feedback**: Receive specific, constructive suggestions rather than generic warnings
- **Seamless Integration**: Works with your existing Git workflow, CI/CD pipeline, and development environment

### Key Features

- **Intelligent Code Analysis**: Detects potential bugs, performance issues, and maintainability concerns
- **Project-Specific Rules**: Enforces your team's coding standards and best practices
- **Multiple Output Formats**: Supports text, JSON, and Markdown output for flexible integration
- **Git Integration**: Analyzes changes based on git diff or specific files
- **Customizable Rule Sets**: Adapt the tool to your project's specific needs
- **Embedding-Based Context**: Uses FastEmbed (local embeddings) to provide context-aware recommendations
- **LLM-Powered Analysis**: Uses Anthropic Claude for in-depth code review with context
- **Incremental Embedding Updates**: Efficiently updates embeddings only for changed files

### Project Alignment

This tool is specifically designed to align with diverse project needs by:

- Supporting analysis of multiple programming languages
- Providing specialized support for TypeScript/JavaScript with React-specific rules
- Integrating with Git-based workflows
- Enforcing team coding standards and best practices
- Providing feedback in formats compatible with various development tools
- Scaling to handle codebases of different sizes and complexities
- Being easily runnable in any project type via npx

## Installation

### Dependencies and Requirements

The AI Code Review Tool requires:

- Node.js v22.0.0 or higher
- Git (for diff-based analysis)
- Anthropic API key (for LLM analysis with Claude)

### API Keys Setup

The tool requires an API key for:

- **Anthropic** - Used for code analysis with Claude

Note: The tool uses FastEmbed for generating embeddings locally, so no additional API key is needed for embeddings.

You can provide the API key in two ways:

1. **Environment Variables**:

   ```bash
   # Set directly in your terminal session
   export ANTHROPIC_API_KEY=your_anthropic_api_key

   # Or provide inline when running the command
   ANTHROPIC_API_KEY=your_key npx ai-code-review analyze --file app.py
   ```

2. **.env File**:
   Create a `.env` file in your project directory:
   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ```

### Installation Options

#### Option 1: Using npx (Recommended for any project type)

You can run the tool directly using `npx` without installing it:

```bash
# With .env file in your project
npx ai-code-review analyze --file path/to/file.py

# Or with inline environment variables
ANTHROPIC_API_KEY=your_key npx ai-code-review analyze --file path/to/file.py
```

This works in any project type (JavaScript, Python, Ruby, etc.) as long as you have Node.js installed on your system.

#### Option 2: Global Installation

1. **Install the package globally**:

   ```bash
   npm install -g ai-code-review
   ```

2. **Run the tool from any directory**:

   ```bash
   # With .env file in your project
   ai-code-review analyze --file path/to/file.py

   # Or with inline environment variables
   ANTHROPIC_API_KEY=your_key ai-code-review analyze --file path/to/file.py
   ```

#### Option 3: Using the Shell Script Wrapper

For non-JS projects, you can use the provided shell script wrapper:

1. **Copy the shell script to your project**:

   ```bash
   curl -o ai-code-review.sh https://raw.githubusercontent.com/yourusername/ai-code-review/main/ai-code-review.sh
   chmod +x ai-code-review.sh
   ```

2. **Run the tool using the shell script**:

   ```bash
   # With .env file in your project
   ./ai-code-review.sh analyze --file path/to/file.py

   # Or with inline environment variables
   ANTHROPIC_API_KEY=your_key ./ai-code-review.sh analyze --file path/to/file.py
   ```

### Configuration Options

Create a configuration file in your project root or specify one with the `--config` flag:

```json
{
  "ruleset": "default",
  "ignore": ["component-naming", "style-module"],
  "severity": ["critical", "major", "minor"],
  "rules": [
    {
      "id": "component-export",
      "enabled": true,
      "severity": "major"
    }
  ]
}
```

## Usage

### Basic Command Syntax

```bash
ai-code-review <command> [options]
```

### Available Commands

- **analyze**: Analyze code for issues
- **embeddings:generate**: Generate embeddings for the codebase
- **embeddings:clear**: Clear stored embeddings for the current project
- **embeddings:clear-all**: Clear ALL stored embeddings (affects all projects)
- **embeddings:stats**: Show statistics about stored embeddings

All embedding commands support the `--directory` option to target a specific project directory.

### Command Options

#### Analyze Command

| Option                     | Description                               | Default                     |
| -------------------------- | ----------------------------------------- | --------------------------- |
| `-d, --diff-with <branch>` | Branch to diff against                    | `main`                      |
| `-f, --files <files...>`   | Specific files or patterns to review      |                             |
| `-o, --output <format>`    | Output format (text, json, markdown)      | `text`                      |
| `-r, --ruleset <ruleset>`  | Rule set to use (default, strict)         | `default`                   |
| `-i, --ignore <rules>`     | Rules to ignore (comma-separated)         |                             |
| `-s, --severity <levels>`  | Severity levels to show (comma-separated) | `critical,major,minor,info` |
| `-c, --config <path>`      | Path to config file                       |                             |
| `--file <file>`            | Analyze a single file without git diff    |                             |
| `--directory <dir>`        | Process all JS/TS files in directory      |                             |
| `--no-color`               | Disable colored output                    |                             |
| `--verbose`                | Show verbose output                       |                             |
| `--provider <provider>`    | LLM provider to use (anthropic, openai)   | `anthropic`                 |
| `--static-only`            | Use only static analysis without LLM      | `false`                     |

#### Embeddings:Generate Command

| Option                       | Description                                        | Default |
| ---------------------------- | -------------------------------------------------- | ------- |
| `-d, --directory <dir>`      | Directory to process                               | `.`     |
| `-f, --files <files...>`     | Specific files or patterns to process              |         |
| `-c, --concurrency <number>` | Number of concurrent embedding requests            | `3`     |
| `--verbose`                  | Show verbose output                                |         |
| `--exclude <patterns...>`    | Patterns to exclude (e.g., "\*_/_.test.js")        |         |
| `--exclude-file <file>`      | File containing patterns to exclude (one per line) |         |
| `--no-gitignore`             | Disable automatic exclusion of files in .gitignore | `false` |

### Example Usage Scenarios

#### Using in JavaScript/TypeScript Projects

**Review changes against main branch with LLM analysis**:

```bash
npx ai-code-review analyze --diff-with main
```

**Review specific files with static analysis only**:

```bash
npx ai-code-review analyze --files src/components/Button.tsx --static-only
```

**Output results in JSON format**:

```bash
npx ai-code-review analyze --output json > review-results.json
```

**Use strict ruleset**:

```bash
npx ai-code-review analyze --ruleset strict
```

**Analyze all files in a directory**:

```bash
npx ai-code-review analyze --directory src/components
```

**Analyze a single file**:

```bash
npx ai-code-review analyze --file frontend/src/apps/email/ui/EmailOffice365Snippet/EmailOffice365Snippet.tsx
```

#### Using in Non-JavaScript Projects (Python, Ruby, etc.)

**Analyze a Python file**:

```bash
npx ai-code-review analyze --file app.py
```

**Analyze all Python files in a directory**:

```bash
npx ai-code-review analyze --files "**/*.py"
```

**Review changes in a Python project**:

```bash
cd /path/to/python/project
npx ai-code-review analyze --diff-with main
```

**Analyze a Ruby file**:

```bash
npx ai-code-review analyze --file app.rb
```

**Using with the shell script wrapper**:

```bash
./ai-code-review.sh analyze --file app.py
```

**Generate embeddings for the codebase**:

```bash
ai-code-review embeddings:generate
```

**Generate embeddings for specific files**:

```bash
ai-code-review embeddings:generate --files src/components/*.tsx
```

**Generate embeddings with exclusion patterns**:

```bash
ai-code-review embeddings:generate --exclude "**/*.test.js" "**/*.spec.js" "docs/**"
```

**Generate embeddings using an exclusion file**:

```bash
ai-code-review embeddings:generate --exclude-file .embedignore
```

**Generate embeddings ignoring .gitignore files**:

```bash
ai-code-review embeddings:generate --no-gitignore
```

**Show embedding statistics for all projects**:

```bash
ai-code-review embeddings:stats
```

**Show embedding statistics for specific project**:

```bash
ai-code-review embeddings:stats --directory /path/to/project
```

**Clear embeddings for current project**:

```bash
ai-code-review embeddings:clear
```

**Clear embeddings for specific project**:

```bash
ai-code-review embeddings:clear --directory /path/to/project
```

**Clear all embeddings (affects all projects)**:

```bash
ai-code-review embeddings:clear-all
```

## Using in Non-JavaScript Projects

The AI Code Review tool can be used in any project type, not just JavaScript or TypeScript projects. Here's how to use it effectively in non-JS projects:

### Quick Start for Non-JS Projects

1. **Ensure Node.js is installed** (v22.0.0 or higher)

2. **Set up API key**:

   Create a `.env` file in your project directory:

   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ```

   Or prepare to provide it inline with the command.

3. **Run the tool using npx**:

   ```bash
   # Navigate to your non-JS project
   cd /path/to/your/python/project

   # Run the tool directly with npx (using .env file)
   npx ai-code-review analyze --file app.py

   # Or with inline environment variables
   ANTHROPIC_API_KEY=your_key npx ai-code-review analyze --file app.py
   ```

### Language Support

While the tool has specialized support for JavaScript and TypeScript, it can analyze code in any language including:

- Python
- Ruby
- Java
- C/C++
- Go
- PHP
- And more

The AI-powered analysis works across all languages, providing valuable insights regardless of the programming language used.

### Setting Up in Non-JS Projects

For regular use in a non-JS project, you can:

1. **Add the shell script to your project**:

   ```bash
   # Download the shell script
   curl -o ai-code-review.sh https://raw.githubusercontent.com/yourusername/ai-code-review/main/ai-code-review.sh
   chmod +x ai-code-review.sh

   # Add to .gitignore (optional)
   echo "ai-code-review.sh" >> .gitignore
   ```

2. **Create a simple alias in your project's Makefile** (if applicable):

   ```makefile
   # In your Makefile
   code-review:
       npx ai-code-review analyze --diff-with main

   code-review-file:
       npx ai-code-review analyze --file $(FILE)
   ```

3. **Add to your project's README** for team awareness:

   ````markdown
   ## Code Review

   This project uses AI-powered code review. To run:

   ```bash
   npx ai-code-review analyze --diff-with main
   ```
   ````

   ```

   ```

### Output Formats and Interpretation

The tool supports three output formats:

**Text (default)**:

```
===== AI Code Review Summary =====
Files analyzed: 3
Total issues: 7

Issues by severity:
  Critical: 1
  Major: 3
  Minor: 2
  Info: 1

Issues by category:
  naming: 2
  structure: 3
  react: 2

===== Detailed Issues =====

src/components/Button.tsx
  [MAJOR] component-naming: Component name 'ButtonComponent' doesn't match filename 'Button'
    Location: Line 5, Column 0
    Suggestion: Rename component to 'Button' or update the file name to match

===== AI-Powered Code Review Results =====

File: src/components/Button.tsx
Summary: The component has several issues including naming inconsistency, missing prop validation, and potential performance optimizations.

Issues:
1. Component name 'ButtonComponent' doesn't match the filename 'Button'
2. Missing prop type validation
3. Unnecessary re-renders due to inline function definitions
...
```

**JSON**:

```json
{
  "summary": {
    "totalFiles": 3,
    "totalIssues": 7,
    "issuesBySeverity": {
      "critical": 1,
      "major": 3,
      "minor": 2,
      "info": 1
    },
    "issuesByCategory": {
      "naming": 2,
      "structure": 3,
      "react": 2
    }
  },
  "results": [
    {
      "file": "src/components/Button.tsx",
      "issues": [
        {
          "rule": "component-naming",
          "severity": "major",
          "message": "Component name 'ButtonComponent' doesn't match filename 'Button'",
          "location": {
            "line": 5,
            "column": 0
          },
          "suggestion": "Rename component to 'Button' or update the file name to match"
        }
      ]
    }
  ],
  "llmReviews": [
    {
      "filePath": "src/components/Button.tsx",
      "analysis": "The component has several issues including naming inconsistency, missing prop validation, and potential performance optimizations...",
      "model": "claude-3-sonnet-20240229"
    }
  ]
}
```

## Architecture

### Overview of Components

The AI Code Review Tool consists of several key components that work together:

1. **Command Line Interface (index.js)**: The entry point that handles user input and orchestrates the review process
2. **Code Analyzer (analyzer.js)**: Parses and analyzes code to extract structure and identify potential issues
3. **Rules Engine (rules.js)**: Defines and applies rules to the analyzed code
4. **Prompt Manager (prompts.js)**: Constructs prompts for AI-powered analysis
5. **Embeddings System (embeddings.js)**: Generates and manages code embeddings using FastEmbed for context-aware analysis
6. **LLM Integration (llm.js)**: Handles communication with Anthropic Claude for in-depth code analysis

### How Components Work Together

The tool follows this workflow:

1. The CLI parses command-line arguments and identifies files to analyze
2. The embeddings system provides context from the broader codebase
3. The analyzer parses each file and extracts its structure (functions, classes, imports, etc.)
4. The rules engine applies project-specific rules to the analyzed code
5. The prompt manager constructs prompts for AI analysis
6. The LLM integration sends prompts to Claude and processes responses
7. Results are formatted and displayed according to the specified output format

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    CLI      │────▶│  Analyzer   │────▶│ Rules Engine│
└─────────────┘     └─────────────┘     └─────────────┘
       │                   ▲                   │
       │                   │                   ▼
       │             ┌─────────────┐     ┌─────────────┐
       └────────────▶│ Embeddings  │◀────│   Prompt    │
                     │   System    │     │   Manager   │
                     └─────────────┘     └─────────────┘
                           │                   │
                           ▼                   ▼
                     ┌─────────────┐     ┌─────────────┐
                     │  LanceDB    │     │    LLM      │
                     │  Storage    │     │ Integration  │
                     └─────────────┘     └─────────────┘
```

### Embedding System Explanation

The embedding system is a key innovation that enables context-aware code reviews:

1. **Code Representation**: Converts code into numerical vectors (embeddings) using FastEmbed's bge-small-en-v1.5 model
2. **Similarity Search**: Finds related code patterns across the codebase using LanceDB
3. **Context Building**: Provides relevant context to the analyzer and LLM
4. **Incremental Updates**: Efficiently updates embeddings only for changed files
5. **File Exclusion**: Intelligently excludes files based on patterns and .gitignore rules

The system uses a hierarchical approach:

- **File-level embeddings**: Capture overall purpose and structure
- **Function/Class-level embeddings**: Capture component behavior
- **Code block-level embeddings**: Capture implementation details

#### File Exclusion Capabilities

The embedding system supports several ways to exclude files from processing:

1. **Gitignore Integration**: Automatically respects all patterns in `.gitignore` files
2. **Custom Exclusion Patterns**: Supports glob patterns for excluding specific files or directories
3. **Exclusion Files**: Allows defining exclusion patterns in a dedicated file (similar to `.gitignore`)
4. **Nested Gitignore Support**: Correctly handles nested `.gitignore` files in subdirectories

Example exclusion file (`.embedignore`):

```
# Exclude test files
**/*.test.js
**/*.spec.js

# Exclude documentation
docs/**

# Exclude large generated files
**/generated/*.json

# Exclude specific directories
node_modules/
dist/
build/
```

## API Requirements

### Anthropic API

The tool uses Anthropic's API for code analysis:

- **Model**: claude-3-sonnet-20240229
- **API Key**: Required in the `.env` file as `ANTHROPIC_API_KEY`
- **Usage**: Analyzes code and provides detailed feedback
- **Pricing**: Check [Anthropic's pricing page](https://www.anthropic.com/pricing) for current rates

### Embeddings

The tool uses FastEmbed for generating embeddings locally:

- **Model**: bge-small-en-v1.5 (384 dimensions)
- **API Key**: No API key required - runs locally
- **Usage**: Generates embeddings for code files and queries to provide context-aware analysis
- **Cost**: Free - no external API calls for embeddings
- **Cache Location**: Model files are cached in `~/.ai-review-fastembed-cache` (user's home directory)
- **Database Location**: Embeddings database stored in `~/.ai-review-lancedb` (user's home directory)
- **First Run**: The model (~100MB) will be downloaded automatically on first use
- **Project Isolation**: Each project's embeddings are stored separately and can be cleared independently

#### Project-Specific Embedding Management

The tool maintains separate embeddings for each project while sharing the same global database:

- **Generate**: `ai-code-review embeddings:generate` - Creates embeddings for the current project
- **Search**: Similarity searches automatically filter results to the current project only
- **Clear Project**: `ai-code-review embeddings:clear` - Removes only the current project's embeddings
- **Clear All**: `ai-code-review embeddings:clear-all` - Removes embeddings for all projects (use with caution)
- **Stats**: `ai-code-review embeddings:stats` - Shows statistics for all projects combined

#### How Project Isolation Works

1. **File Path Storage**: Each embedding stores the relative path from the project root
2. **Project Identification**: The tool identifies project boundaries using:
   - The `--directory` option if specified
   - The current working directory if no `--directory` option
3. **Automatic Filtering**: All similarity searches automatically filter results to the current project
4. **Project Structure**: Each project gets its own project structure embedding with a unique identifier

#### CLI Usage Scenarios

**Scenario 1: Tool used via npm/npx in consumer project**

```bash
cd /path/to/my-project
npx ai-code-review analyze --file src/app.py
# Project path: /path/to/my-project (from process.cwd())
```

**Scenario 2: Tool executed locally from its own folder**

```bash
cd /path/to/ai-code-review
node index.js analyze --directory /path/to/my-project --file src/app.py
# Project path: /path/to/my-project (from --directory option)
```

**Scenario 3: Global installation targeting specific project**

```bash
ai-code-review analyze --directory /path/to/my-project --file src/app.py
# Project path: /path/to/my-project (from --directory option)
```

This approach allows you to:

- Work on multiple projects without interference between their embeddings
- Get relevant results only from the current project when analyzing code
- Clear embeddings for one project without affecting others
- Share the embedding model and database infrastructure globally for efficiency

### Rate Limiting and Cost Management

The tool implements several strategies to manage API usage and costs:

1. **Incremental Embedding Updates**: Only regenerates embeddings for modified files
2. **Batch Processing**: Processes embeddings in batches to optimize API calls
3. **Caching**: Caches embeddings to avoid redundant API calls
4. **Concurrency Control**: Limits the number of concurrent API requests
5. **Static Analysis Fallback**: Provides an option to use only static analysis without LLM

## Customization

### Adding Custom Rules

You can add custom rules by creating a configuration file:

```json
{
  "rules": [
    {
      "id": "custom-rule-id",
      "name": "Custom Rule Name",
      "description": "Description of what the rule checks for",
      "category": "best-practice",
      "severity": "major",
      "enabled": true
    }
  ]
}
```

For more complex rules, you can extend the rules engine in your own fork of the tool.

### Modifying Prompt Templates

The tool uses prompt templates for AI-powered analysis. You can modify these templates in `prompts.js` and `llm.js`:

```javascript
// Example of customizing the React component review prompt
const CUSTOM_REACT_COMPONENT_REVIEW_PROMPT = `
You are an expert React developer with deep knowledge of our team's best practices.
Review the following React component and provide constructive feedback:

COMPONENT:
{code}

DIFF:
{diff}

Please analyze the component for:
1. Component structure and organization
2. Props usage and validation
3. State management
4. Performance optimizations
5. Our team's specific conventions:
   - PascalCase for component names
   - One component per file
   - Props interface should be exported
   - ...

Focus on providing actionable feedback with specific suggestions for improvement.
`;
```

### Configuring Severity Levels

You can configure severity levels for rules in your configuration file:

```json
{
  "rules": [
    {
      "id": "component-naming",
      "severity": "critical"
    },
    {
      "id": "prop-validation",
      "severity": "minor"
    }
  ]
}
```

The available severity levels are:

- **critical**: Must be fixed immediately (e.g., security issues, broken builds)
- **major**: Should be fixed soon (e.g., performance issues, bad practices)
- **minor**: Should be fixed when convenient (e.g., style issues, minor optimizations)
- **info**: Informational only (e.g., suggestions, best practices)

## Future Development

### Planned Features and Enhancements

The AI Code Review Tool roadmap includes:

1. **Enhanced Language Support**: Expand beyond JavaScript/TypeScript to support additional languages
2. **Improved Context Awareness**: Enhance the embedding system to better understand project-specific patterns
3. **Performance Optimization**: Improve analysis speed and resource efficiency
4. **Rule Suggestion**: Automatically suggest new rules based on codebase patterns
5. **Interactive Reviews**: Add support for interactive reviews with developer feedback
6. **Historical Analysis**: Track code quality trends over time

### Integration with AI Models

Future versions will include:

- **Additional LLM Providers**: Integration with other AI providers like Google and Cohere
- **Self-Hosted LLM Options**: Support for running local LLMs for enhanced privacy
- **Fine-Tuning Capabilities**: Allow fine-tuning models on your codebase for better results
- **Multi-Modal Analysis**: Support for analyzing code alongside documentation and tests

### Potential Workflow Integrations

We plan to integrate with:

- **IDE Extensions**: Direct integration with VS Code, WebStorm, and other IDEs
- **CI/CD Pipelines**: Enhanced GitHub Actions, GitLab CI, and Jenkins integration
- **Code Review Platforms**: Direct integration with GitHub PR reviews, GitLab MR reviews
- **Team Collaboration Tools**: Integration with Slack, Microsoft Teams, etc.
- **MCP Server Implementation**: Function as an MCP (Model Context Protocol) server for integration with AI assistants

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
