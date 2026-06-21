/**
 * Parse git unified diff hunks into new-file line metadata.
 *
 * @param {string} diffContent - Git diff text.
 * @param {object} options - Parser options.
 * @param {boolean} [options.includeRemovalAnchors=false] - Include deletion anchors in changedLineNumbers.
 * @param {boolean} [options.includeHunkStartFallback=false] - Use hunk starts when a hunk has no added/deleted anchors.
 * @returns {{addedLines: Array<{lineNumber: number, content: string}>, removedLines: Array<{content: string}>, contextLines: Array<{lineNumber: number, content: string}>, changedLineNumbers: number[]}}
 */
export function parseDiffLineInfo(diffContent = '', options = {}) {
  const addedLines = [];
  const removedLines = [];
  const contextLines = [];
  const changedLineNumbers = [];
  const hunkStartLines = [];
  const lines = diffContent.split('\n');
  let currentNewLine = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentNewLine = null;
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number.parseInt(hunkMatch[1], 10);
      hunkStartLines.push(Math.max(1, currentNewLine));
      continue;
    }

    if (currentNewLine === null) {
      continue;
    }

    if (line.startsWith('+')) {
      const lineNumber = Math.max(1, currentNewLine);
      addedLines.push({ lineNumber, content: line.slice(1) });
      changedLineNumbers.push(lineNumber);
      currentNewLine++;
    }
    else if (line.startsWith('-')) {
      removedLines.push({ content: line.slice(1) });
      if (options.includeRemovalAnchors) {
        changedLineNumbers.push(Math.max(1, currentNewLine));
      }
    }
    else if (line.startsWith(' ')) {
      contextLines.push({ lineNumber: currentNewLine, content: line.slice(1) });
      currentNewLine++;
    }
  }

  return {
    addedLines,
    removedLines,
    contextLines,
    changedLineNumbers: changedLineNumbers.length > 0 || !options.includeHunkStartFallback ? changedLineNumbers : hunkStartLines,
  };
}
