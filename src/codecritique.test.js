import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';

const execFileAsync = promisify(execFile);

async function runWrapper(envFile, args = [], command = 'codecritique', extraEnv = {}, envIsDirectory = false) {
  const directory = await mkdtemp(join(tmpdir(), 'codecritique-shell-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const fakeCommand = join(directory, command);

  if (envIsDirectory) {
    await mkdir(join(directory, '.env'));
  }
  else if (envFile !== null) {
    await writeFile(join(directory, '.env'), envFile);
  }
  await writeFile(
    fakeCommand,
    '#!/bin/bash\n[ "$1" = "--terminate" ] && kill -TERM $$\nprintf "key=%s\\n" "$ANTHROPIC_API_KEY"\nprintf "node_options=%s\\n" "$NODE_OPTIONS"\nprintf "arg=%s\\n" "$@"\n'
  );
  await chmod(fakeCommand, 0o755);
  await symlink(process.execPath, join(directory, 'node'));

  const result = await execFileAsync('/bin/bash', [join(import.meta.dirname, 'codecritique.sh'), ...args], {
    cwd: directory,
    env: { PATH: directory, ...extraEnv },
  });

  return { ...result, directory };
}

describe('codecritique.sh', () => {
  it.each([
    ['unquoted spaces and globs', 'ANTHROPIC_API_KEY=value with spaces *\n', 'value with spaces *'],
    ['literal JSON quotes', 'ANTHROPIC_API_KEY={"token":"a*b c"}\n', '{"token":"a*b c"}'],
  ])('loads %s without corruption', async (_label, envFile, expected) => {
    const { stdout } = await runWrapper(envFile, ['--flag', 'value with spaces']);

    expect(stdout).toContain(`key=${expected}`);
    expect(stdout).toContain('arg=--flag');
    expect(stdout).toContain('arg=value with spaces');
  });

  it('does not execute .env contents', async () => {
    const { directory, stdout } = await runWrapper(
      'ANTHROPIC_API_KEY=test\nMALICIOUS=$(touch executed)\nNODE_OPTIONS=--require=./does-not-exist.cjs\n'
    );

    expect(stdout).toContain('key=test');
    expect(stdout).toContain('node_options=\n');
    await expect(access(join(directory, 'executed'))).rejects.toThrow();
  });

  it('preserves an inherited API key when .env is absent', async () => {
    const { stdout } = await runWrapper(null, [], 'codecritique', { ANTHROPIC_API_KEY: 'inherited' });

    expect(stdout).toContain('key=inherited');
  });

  it('keeps the original .env-over-inherited-value precedence', async () => {
    const { stdout } = await runWrapper('ANTHROPIC_API_KEY=from-file\n', [], 'codecritique', {
      ANTHROPIC_API_KEY: 'from-parent',
    });

    expect(stdout).toContain('key=from-file');
  });

  it('warns when no Anthropic credentials are configured', async () => {
    const { stderr } = await runWrapper(null);

    expect(stderr).toContain('Warning: ANTHROPIC_API_KEY is not set.');
  });

  it('does not treat an unsupported Anthropic auth token as configured', async () => {
    const { stderr } = await runWrapper('ANTHROPIC_AUTH_TOKEN=token\n');

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
