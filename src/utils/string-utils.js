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
