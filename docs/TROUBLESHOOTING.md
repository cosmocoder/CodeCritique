# Troubleshooting Guide

This guide helps you resolve common issues when using CodeCritique. If you encounter problems not covered here, please check the [main README](../README.md) or open an issue on GitHub.

## Common Issues

### API Key Issues

**Error**: `ANTHROPIC_API_KEY is required for analysis. Set it in env or .env before running analyze.`

**Solution**: Set environment variable or create .env file

```bash
export ANTHROPIC_API_KEY=your_api_key
# Or create .env file
echo "ANTHROPIC_API_KEY=your_api_key" > .env
```

### Git Repository Issues

**Error**: `Not a git repository`

**Solution**: Ensure you're in a git repository when using `--diff-with`

```bash
git init  # If needed
git add .
git commit -m "Initial commit"
```

### File Not Found

**Error**: `File not found: path/to/file.js`

**Solution**: Check file path and ensure it exists, use absolute path or verify relative path

```bash
# Use absolute path
codecritique analyze --file /full/path/to/file.js

# Or verify relative path
ls path/to/file.js  # Verify file exists
```

### Embedding Generation Issues

**Error**: `Failed to generate embeddings`

**Solutions**: Clear existing embeddings and regenerate, reduce concurrency for memory issues, exclude problematic files

```bash
# Clear existing embeddings and regenerate
codecritique embeddings:clear
codecritique embeddings:generate --verbose

# Reduce concurrency for memory issues
codecritique embeddings:generate --concurrency 5

# Exclude problematic files
codecritique embeddings:generate --exclude "large-files/**"
```

### Memory Issues

**Error**: `JavaScript heap out of memory`

**Solutions**: Increase Node.js memory limit with `NODE_OPTIONS="--max-old-space-size=4096"`, process fewer files at once, exclude large files

```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"

# Process fewer files at once
codecritique embeddings:generate --concurrency 3

# Exclude large files
codecritique embeddings:generate --exclude "**/*.min.js" "dist/**"
```

## Debugging

Enable verbose output for detailed logging:

```bash
codecritique analyze --file app.py --verbose
```

You can also use environment variables to enable verbose logging:

```bash
VERBOSE=true codecritique analyze --file app.py
# Or use DEBUG environment variable
DEBUG=true codecritique analyze --file app.py
```

> **Note**: Both `--verbose`, `VERBOSE=true`, and `DEBUG=true` (or any truthy value) enable detailed logging output.

## Performance Optimization

1. **Generate embeddings first** for better context:

   ```bash
   codecritique embeddings:generate
   codecritique analyze --files "src/**/*.ts"
   ```

2. **Use exclusion patterns** to skip irrelevant files:

   ```bash
   codecritique embeddings:generate --exclude "**/*.test.js" "dist/**"
   ```

3. **Adjust concurrency** based on system resources:

   ```bash
   # For powerful machines
   codecritique embeddings:generate --concurrency 20

   # For resource-constrained environments
   codecritique embeddings:generate --concurrency 3
   ```

   Default concurrency values by command:
   - `embeddings:generate`: 10 (higher for batch processing)
   - `analyze`: 3 (moderate for balanced resource usage)
   - `pr-history:analyze`: 2 (conservative for API rate limiting)

---

For more information, see the [main README](../README.md).
