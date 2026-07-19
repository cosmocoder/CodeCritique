import { expect, it, onTestFinished, vi } from 'vitest';

const { originalArgv, originalListeners, reviewFile } = vi.hoisted(() => {
  const originalArgv = process.argv;
  const originalListeners = Object.fromEntries(['SIGINT', 'SIGTERM', 'exit'].map((event) => [event, process.listeners(event)]));
  process.argv = ['node', 'index.js', 'analyze', '--file', 'src/index.js', '--max-examples', '12'];
  return {
    originalArgv,
    originalListeners,
    reviewFile: vi.fn().mockResolvedValue({ success: true, results: [] }),
  };
});

vi.unmock('chalk');
vi.mock('./rag-review.js', () => ({
  reviewFile,
  reviewFiles: vi.fn(),
  reviewPullRequest: vi.fn(),
}));

import './index.js';

it('parses integer options independently of Commander defaults', async () => {
  onTestFinished(() => {
    process.argv = originalArgv;
    for (const [event, listeners] of Object.entries(originalListeners)) {
      process
        .listeners(event)
        .filter((listener) => !listeners.includes(listener))
        .forEach((listener) => process.removeListener(event, listener));
    }
  });
  await vi.waitFor(() => expect(reviewFile).toHaveBeenCalled());
  expect(reviewFile.mock.calls[0][1].maxExamples).toBe(12);
});
