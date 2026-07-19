import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { program } from 'commander';
import { expect, it, onTestFinished, vi } from 'vitest';

const { originalArgv, originalListeners, reviewFile } = vi.hoisted(() => {
  const originalArgv = process.argv;
  const originalListeners = Object.fromEntries(['SIGINT', 'SIGTERM', 'exit'].map((event) => [event, process.listeners(event)]));
  process.argv = ['node', 'index.js', 'analyze', '--file', 'src/index.js', '--max-examples', '12'];
  return {
    originalArgv,
    originalListeners,
    reviewFile: vi.fn().mockResolvedValue({
      success: false,
      error: 'Review incomplete',
      results: [
        {
          filePath: 'src/index.js',
          success: true,
          partial: true,
          error: 'Batch expired',
          results: { issues: [{ severity: 'high', description: 'Visible partial finding', lineNumbers: [1] }] },
        },
      ],
    }),
  };
});

vi.unmock('chalk');
vi.mock('./rag-review.js', () => ({
  reviewFile,
  reviewFiles: vi.fn(),
  reviewPullRequest: vi.fn(),
}));

import './index.js';

it('parses integer options and renders incomplete results in every output format', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codecritique-output-'));
  onTestFinished(async () => {
    process.argv = originalArgv;
    for (const [event, listeners] of Object.entries(originalListeners)) {
      process
        .listeners(event)
        .filter((listener) => !listeners.includes(listener))
        .forEach((listener) => process.removeListener(event, listener));
    }
    await rm(directory, { recursive: true, force: true });
  });
  await vi.waitFor(() => expect(reviewFile).toHaveBeenCalled());
  expect(reviewFile.mock.calls[0][1].maxExamples).toBe(12);
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith('    Visible partial finding'));
  expect(console.log.mock.calls.some(([message]) => String(message).includes('Partial review for src/index.js'))).toBe(true);
  expect(console.log.mock.calls.some(([message]) => String(message).includes('Review incomplete'))).toBe(true);

  const jsonPath = join(directory, 'review.json');
  await program.parseAsync(['node', 'index.js', 'analyze', '--file', 'src/index.js', '--output', 'json', '--output-file', jsonPath]);
  const jsonOutput = JSON.parse(await readFile(jsonPath, 'utf8'));
  expect(jsonOutput.summary).toEqual(expect.objectContaining({ errorFiles: 0, incomplete: true, error: 'Review incomplete' }));
  expect(jsonOutput.details).toEqual([
    expect.objectContaining({
      success: true,
      partial: true,
      error: 'Batch expired',
      review: expect.objectContaining({ issues: [expect.objectContaining({ description: 'Visible partial finding' })] }),
    }),
  ]);

  const markdownPath = join(directory, 'review.md');
  await program.parseAsync([
    'node',
    'index.js',
    'analyze',
    '--file',
    'src/index.js',
    '--output',
    'markdown',
    '--output-file',
    markdownPath,
  ]);
  const markdownOutput = await readFile(markdownPath, 'utf8');
  expect(markdownOutput).toContain('**Review Incomplete:** Review incomplete');
  expect(markdownOutput).toContain('**Partial review:** Batch expired');
  expect(markdownOutput).toContain('Visible partial finding');
});
