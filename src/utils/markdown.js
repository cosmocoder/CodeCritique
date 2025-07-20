/**
 * Markdown Processing Module
 *
 * This module provides utilities for processing markdown content,
 * including chunk extraction, heading analysis, and content parsing.
 */

import path from 'path';

/**
 * Extracts chunks from Markdown content based on H2 and H3 headings,
 * and also extracts the first H1 heading as the document title.
 *
 * @param {string} filePath - The absolute path to the file
 * @param {string} content - The Markdown content of the file
 * @param {string} relativePath - The relative path of the file
 * @returns {Object} An object containing `chunks` (Array) and `documentH1` (string|null).
 *                   Each chunk object contains:
 *                          `content`, `heading` (H2/H3 text),
 *                          `original_document_path`, `start_line_in_doc`, `language`.
 *
 * @example
 * const result = extractMarkdownChunks('/path/to/file.md', '# Title\n## Section\nContent...', 'docs/file.md');
 * // Returns: { chunks: [{ content: '...', heading: 'Section', ... }], documentH1: 'Title' }
 */
export function extractMarkdownChunks(filePath, content, relativePath) {
  const chunks = [];
  let documentH1 = null;
  if (!content || typeof content !== 'string') return { chunks, documentH1 };

  const lines = content.split('\n');
  let currentChunkLines = [];
  let currentH2H3Heading = null; // Stores the H2 or H3 heading for the current chunk
  let chunkStartLine = 1;
  let inCodeBlock = false;
  let h1Found = false;
  let linesProcessedForH1 = 0; // Debug counter

  const h1Regex = /^#\s*(.*)/; // Regex for H1 (allow zero or more spaces after #)
  const h2h3Regex = /^(##|###)\s+(.*)/; // Regex for H2 or H3

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    if (!h1Found && linesProcessedForH1 < 5) {
      linesProcessedForH1++;
      // Check for H1 heading in first few lines
      if (filePath.includes('README.md') || filePath.includes('RUNBOOK.md')) {
        // Log only for specific files to reduce noise
        console.log(`[extractMarkdownChunks DEBUG] File: ${filePath}, Line ${i + 1} (trimmed): "${trimmedLine}", Attempting H1 match.`);
      }
      const h1Match = trimmedLine.match(h1Regex);
      if (h1Match) {
        documentH1 = h1Match[1].trim();
        h1Found = true;
        console.log(`[extractMarkdownChunks DEBUG] H1 FOUND for ${filePath}: "${documentH1}" on line ${i + 1}`);
      } else if (filePath.includes('README.md') || filePath.includes('RUNBOOK.md')) {
        if (linesProcessedForH1 <= 5 && trimmedLine.startsWith('#')) {
          // If it starts with # but didn't match
          console.log(
            `[extractMarkdownChunks DEBUG] File: ${filePath}, Line ${i + 1}: Starts with # but H1Regex DID NOT match "${trimmedLine}"`
          );
        }
      }
    }

    const h2h3Match = !inCodeBlock && trimmedLine.match(h2h3Regex);

    if (h2h3Match) {
      // Found an H2 or H3 heading, finalize the previous chunk if it has content
      if (currentChunkLines.length > 0 && currentChunkLines.join('\n').trim().length > 0) {
        chunks.push({
          content: currentChunkLines.join('\n').trim(),
          heading: currentH2H3Heading, // Heading of the *previous* H2/H3 chunk
          original_document_path: relativePath,
          start_line_in_doc: chunkStartLine,
          language: 'markdown',
        });
      }
      // Start a new H2/H3 chunk
      currentH2H3Heading = h2h3Match[2].trim();
      currentChunkLines = [line]; // Include H2/H3 heading line in the new chunk's content
      chunkStartLine = i + 1;
    } else {
      // Not an H1 or H2/H3 heading line (or H1 already found), add to current chunk
      // This also correctly captures content before the first H2/H3 heading (under an H1 or if no H1).
      currentChunkLines.push(line);
    }
  }

  // Add the last processed chunk if it has content
  if (currentChunkLines.length > 0 && currentChunkLines.join('\n').trim().length > 0) {
    chunks.push({
      content: currentChunkLines.join('\n').trim(),
      heading: currentH2H3Heading, // H2/H3 heading of the last chunk
      original_document_path: relativePath,
      start_line_in_doc: chunkStartLine,
      language: 'markdown',
    });
  }

  // If no H2/H3 chunks were created (e.g., file has only H1 and paragraphs, or just paragraphs)
  // treat the whole file content (that wasn't part of H1 line itself if H1 was first line) as a single chunk.
  if (chunks.length === 0 && content.trim().length > 0) {
    let initialContent = content.trim();
    // If H1 was the very first line and we captured it, remove it from this single chunk content
    if (documentH1 && lines.length > 0 && lines[0].trim().match(h1Regex)) {
      initialContent = lines.slice(1).join('\n').trim();
    }
    if (initialContent.length > 0) {
      chunks.push({
        content: initialContent,
        heading: null, // No H2/H3 heading for this single chunk
        original_document_path: relativePath,
        start_line_in_doc: h1Found && lines.length > 0 && lines[0].trim().match(h1Regex) ? 2 : 1,
        language: 'markdown',
      });
    }
  }

  if (!documentH1) {
    documentH1 = path.basename(filePath).replace(path.extname(filePath), '');
    console.log(`[extractMarkdownChunks DEBUG] H1 NOT FOUND for ${filePath}. Using fallback title: "${documentH1}"`);
  }

  return { chunks: chunks.filter((chunk) => chunk.content.length > 0), documentH1 };
}
