import path from 'node:path';

/**
 * Check whether an absolute path is contained within a project root.
 *
 * @param {string} absolutePath - Absolute path to validate
 * @param {string} projectPath - Project root path
 * @returns {boolean} True when the path is inside the project
 */
export function isPathWithinProject(absolutePath, projectPath) {
  const relativePath = path.relative(projectPath, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
