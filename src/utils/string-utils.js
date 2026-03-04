/**
 * String Utilities Module
 *
 * This module provides utilities for string manipulation, formatting,
 * and text processing operations.
 */

/**
 * Slugify text for use in IDs and URLs
 *
 * @param {string} text - The text to slugify
 * @returns {string} A slugified string safe for use in IDs and URLs
 *
 * @example
 * slugify('Hello World!'); // 'hello-world'
 * slugify('My Component Name'); // 'my-component-name'
 * slugify('  Multiple   Spaces  '); // 'multiple-spaces'
 */
export function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w-]+/g, '') // Remove all non-word chars
    .replace(/--+/g, '-'); // Replace multiple - with single -
}

/**
 * Add line numbers to source code content so LLMs can accurately reference
 * specific lines when performing code reviews.
 *
 * Each line is prefixed with its 1-based line number followed by a pipe separator.
 * The line numbers are right-aligned with consistent padding based on the total
 * number of lines, making the output easy to read.
 *
 * @param {string} content - The source code content to annotate
 * @returns {string} The content with line numbers prepended to each line
 *
 * @example
 * addLineNumbers('const a = 1;\nconst b = 2;');
 * // '1 | const a = 1;\n2 | const b = 2;'
 *
 * @example
 * addLineNumbers(''); // ''
 */
export function addLineNumbers(content) {
  if (!content) return '';
  const lines = content.split('\n');
  const padding = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(padding)} | ${line}`).join('\n');
}
