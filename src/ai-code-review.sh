#!/bin/bash

# Shell script wrapper for ai-code-review
# This script can be placed in any project to run ai-code-review

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required but not installed."
    echo "Please install Node.js v22.0.0 or higher: https://nodejs.org/"
    exit 1
fi

# Check if .env file exists in the current directory
if [ -f .env ]; then
    echo "Found .env file in current directory. Loading environment variables..."
    # Export all variables from .env file
    export $(grep -v '^#' .env | xargs)
fi

# Check if required API key is set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "Warning: ANTHROPIC_API_KEY is not set."
    echo "You can set it by:"
    echo "1. Creating a .env file in this directory with:"
    echo "   ANTHROPIC_API_KEY=your_anthropic_api_key"
    echo "2. Or by setting it as an environment variable before running this script:"
    echo "   ANTHROPIC_API_KEY=your_key ./ai-code-review.sh ..."
    echo ""
    echo "Continuing anyway, as you may have set it in your environment..."
    echo ""
fi

# Check if ai-code-review is installed globally
if command -v ai-code-review &> /dev/null; then
    # Run the command with all arguments passed to this script
    ai-code-review "$@"
else
    # Try to run with npx if not installed globally
    echo "ai-code-review not found globally, trying with npx..."
    npx ai-code-review "$@"
fi
