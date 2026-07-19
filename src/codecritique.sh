#!/bin/bash

# Shell script wrapper for codecritique
# This script can be placed in any project to run codecritique

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required but not installed."
    echo "Please install Node.js 24 or newer: https://nodejs.org/"
    exit 1
fi

# Parse only CodeCritique-supported settings so a project .env cannot inject
# process-control options such as NODE_OPTIONS or PATH into the child command.
exec node -e '
  const { spawnSync } = require("node:child_process");
  const { readFileSync } = require("node:fs");
  const { parseEnv } = require("node:util");
  const args = process.argv.slice(1);
  const supportedKeys = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_LOG",
    "GITHUB_TOKEN", "GH_TOKEN", "DEBUG", "VERBOSE"
  ];
  let fileEnv = {};
  try {
    fileEnv = parseEnv(readFileSync(".env", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Unable to load .env: ${error.message}`);
      process.exit(1);
    }
  }
  const env = { ...process.env };
  for (const key of supportedKeys) {
    if (Object.hasOwn(fileEnv, key)) env[key] = fileEnv[key];
  }
  if (!env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. Add it to .env or export it before running CodeCritique.");
  }
  let result = spawnSync("codecritique", args, { stdio: "inherit", env });
  if (result.error?.code === "ENOENT") {
    console.log("codecritique not found globally, trying with npx...");
    result = spawnSync("npx", ["codecritique", ...args], { stdio: "inherit", env });
  }
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) process.exit(128 + require("node:os").constants.signals[result.signal]);
  process.exit(result.status ?? 1);
' -- "$@"
