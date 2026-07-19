import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';

const execFileAsync = promisify(execFile);

async function runWrapper(envFile, args = [], command = 'codecritique', extraEnv = {}, envIsDirectory = false, nodeMajorVersion = null) {
  const directory = await mkdtemp(join(tmpdir(), 'codecritique-shell-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const fakeCommand = join(directory, command);
  const envInspector = join(directory, 'inspect-entry-env.mjs');

  if (envIsDirectory) {
    await mkdir(join(directory, '.env'));
  }
  else if (envFile !== null) {
    await writeFile(join(directory, '.env'), envFile);
  }
  await writeFile(
    envInspector,
    `process.argv = ['node'];
process.exit = code => { throw new Error(\`exit \${code}\`); };
try { await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)}); } catch {}
console.log(\`inspected_node_options=\${process.env.NODE_OPTIONS || ''}\`);
`
  );
  await writeFile(
    fakeCommand,
    `#!/bin/bash
[ "$1" = "--terminate" ] && kill -TERM $$
[ "$1" = "--inspect-entry" ] && exec node "${envInspector}"
[ "$1" = "--inspect-entry-with-dotenv" ] && unset CODECRITIQUE_SKIP_DOTENV && exec node "${envInspector}"
/usr/bin/env
printf "arg=%s\\n" "$@"
`
  );
  await chmod(fakeCommand, 0o755);
  if (nodeMajorVersion === null) {
    await symlink(process.execPath, join(directory, 'node'));
  }
  else {
    await writeFile(
      join(directory, 'node'),
      `#!/bin/bash\nif [ "$1" = "-p" ]; then echo ${nodeMajorVersion}; exit; fi\nif [ "$1" = "--version" ]; then echo v${nodeMajorVersion}.0.0; exit; fi\nexec "${process.execPath}" "$@"\n`
    );
    await chmod(join(directory, 'node'), 0o755);
  }

  const result = await execFileAsync('/bin/bash', [join(import.meta.dirname, 'codecritique.sh'), ...args], {
    cwd: directory,
    env: { PATH: directory, ...extraEnv },
  });

  return { ...result, directory };
}

describe('codecritique.sh', () => {
  it.each([
    [20, 'Error: CodeCritique requires Node.js 24 or newer (found v20.0.0).\n'],
    ['not-a-version', 'Error: Unable to determine the Node.js major version (received: not-a-version).\n'],
  ])('rejects unsupported Node version output: %s', async (nodeVersion, stderr) => {
    await expect(runWrapper(null, [], 'codecritique', {}, false, nodeVersion)).rejects.toMatchObject({
      code: 1,
      stderr,
    });
  });

  it.each([
    ['unquoted spaces and globs', 'ANTHROPIC_API_KEY=value with spaces *\n', 'value with spaces *'],
    ['literal JSON quotes', 'ANTHROPIC_API_KEY={"token":"a*b c"}\n', '{"token":"a*b c"}'],
  ])('loads %s without corruption', async (_label, envFile, expected) => {
    const { stdout } = await runWrapper(envFile, ['--flag', 'value with spaces']);

    expect(stdout).toContain(`ANTHROPIC_API_KEY=${expected}`);
    expect(stdout).toContain('arg=--flag');
    expect(stdout).toContain('arg=value with spaces');
  });

  it('does not execute .env contents', async () => {
    const { directory, stdout } = await runWrapper(
      'ANTHROPIC_API_KEY=test\nMALICIOUS=$(touch executed)\nNODE_OPTIONS=--require=./does-not-exist.cjs\n'
    );

    expect(stdout).toContain('ANTHROPIC_API_KEY=test');
    expect(stdout).not.toContain('NODE_OPTIONS=');
    await expect(access(join(directory, 'executed'))).rejects.toThrow();
  });

  it('prevents the real CLI entry point from reloading filtered .env values', async () => {
    const { stdout } = await runWrapper('ANTHROPIC_API_KEY=test\nNODE_OPTIONS=--require=./does-not-exist.cjs\n', ['--inspect-entry']);

    expect(stdout).toContain('inspected_node_options=\n');
  });

  it('loads .env at the real CLI entry point when the wrapper sentinel is absent', async () => {
    const { stdout } = await runWrapper('ANTHROPIC_API_KEY=test\nNODE_OPTIONS=loaded-by-dotenv\n', ['--inspect-entry-with-dotenv']);

    expect(stdout).toContain('inspected_node_options=loaded-by-dotenv\n');
  });

  it('forwards every supported .env setting', async () => {
    const supportedEnv = {
      ANTHROPIC_API_KEY: 'test',
      ANTHROPIC_BASE_URL: 'https://api.example.test',
      ANTHROPIC_LOG: 'debug',
      GITHUB_TOKEN: 'github-token',
      GH_TOKEN: 'gh-token',
      DEBUG: '1',
      VERBOSE: 'true',
      CI: 'true',
      GITHUB_WORKSPACE_PATH: '/workspace',
    };
    const envFile = Object.entries(supportedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const { stdout } = await runWrapper(envFile);

    for (const [key, value] of Object.entries(supportedEnv)) {
      expect(stdout).toContain(`${key}=${value}`);
    }
  });

  it('reports null bytes in supported values without an internal stack', async () => {
    await expect(runWrapper('ANTHROPIC_API_KEY=test\0value\n')).rejects.toMatchObject({
      stderr: 'Unable to load .env: ANTHROPIC_API_KEY contains a null byte\n',
    });
  });

  it('preserves an inherited API key when .env is absent', async () => {
    const { stdout } = await runWrapper(null, [], 'codecritique', { ANTHROPIC_API_KEY: 'inherited' });

    expect(stdout).toContain('ANTHROPIC_API_KEY=inherited');
  });

  it('keeps the original .env-over-inherited-value precedence', async () => {
    const { stdout } = await runWrapper('ANTHROPIC_API_KEY=from-file\n', [], 'codecritique', {
      ANTHROPIC_API_KEY: 'from-parent',
    });

    expect(stdout).toContain('ANTHROPIC_API_KEY=from-file');
  });

  it.each([null, 'ANTHROPIC_AUTH_TOKEN=token\n'])('warns when no supported Anthropic credentials are configured', async (envFile) => {
    const { stderr } = await runWrapper(envFile);

    expect(stderr).toContain('Warning: ANTHROPIC_API_KEY is not set.');
  });

  it('reports unreadable .env paths without an internal stack', async () => {
    await expect(runWrapper(null, [], 'codecritique', {}, true)).rejects.toMatchObject({
      stderr: expect.stringMatching(/^Unable to load \.env: .+\n$/),
    });
  });

  it('falls back to npx when codecritique is not installed globally', async () => {
    const { stdout } = await runWrapper('ANTHROPIC_API_KEY=test\n', ['--version'], 'npx');

    expect(stdout).toContain('codecritique not found globally, trying with npx...');
    expect(stdout).toContain('arg=codecritique');
    expect(stdout).toContain('arg=--version');
  });

  it('preserves signal-derived child exit codes', async () => {
    await expect(runWrapper('ANTHROPIC_API_KEY=test\n', ['--terminate'])).rejects.toMatchObject({ code: 143 });
  });
});
