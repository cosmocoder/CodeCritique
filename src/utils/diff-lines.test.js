import { parseDiffLineInfo } from './diff-lines.js';

describe('parseDiffLineInfo', () => {
  it('does not count file headers as changes in multi-file diffs', () => {
    const diff = [
      'diff --git a/f1.js b/f1.js',
      '--- a/f1.js',
      '+++ b/f1.js',
      '@@ -1,1 +1,1 @@',
      '-old1',
      '+new1',
      'diff --git a/f2.js b/f2.js',
      '--- a/f2.js',
      '+++ b/f2.js',
      '@@ -3,1 +3,1 @@',
      '-old2',
      '+new2',
    ].join('\n');

    const result = parseDiffLineInfo(diff, { includeRemovalAnchors: true });

    expect(result.addedLines).toEqual([
      { lineNumber: 1, content: 'new1' },
      { lineNumber: 3, content: 'new2' },
    ]);
    expect(result.removedLines).toEqual([{ content: 'old1' }, { content: 'old2' }]);
    expect(result.changedLineNumbers).toEqual([1, 1, 3, 3]);
  });

  it('still treats code lines starting with ++ as additions inside hunks', () => {
    const result = parseDiffLineInfo('@@ -10,0 +10,1 @@\n+++counter;', { includeRemovalAnchors: true });

    expect(result.addedLines).toEqual([{ lineNumber: 10, content: '++counter;' }]);
    expect(result.changedLineNumbers).toEqual([10]);
  });
});
