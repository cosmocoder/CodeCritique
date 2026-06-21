/**
 * Git Operations Module
 *
 * This module provides utilities for git operations including branch management,
 * diff analysis, and content retrieval from different branches or commits.
 */

import { execSync } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import { execGitSafe } from './command.js';
import { parseDiffLineInfo } from './diff-lines.js';
import { verboseLog } from './logging.js';

/**
 * Check if a git branch exists locally
 *
 * @param {string} branchName - The name of the branch to check
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 * @returns {boolean} True if the branch exists, false otherwise
 *
 * @example
 * const exists = checkBranchExists('feature-branch');
 * if (exists) {
 *   console.log('Branch exists locally');
 * }
 */
function checkBranchExists(branchName, workingDir = process.cwd()) {
  try {
    execGitSafe('git show-ref', ['--verify', '--quiet', `refs/heads/${branchName}`], { cwd: workingDir });
    return true;
  }
  catch {
    // Command returns non-zero exit code if branch doesn't exist
    return false;
  }
}

/**
 * Ensure a branch exists locally, fetching from remote if necessary
 *
 * @param {string} branchName - The name of the branch to ensure exists
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 *
 * @example
 * await ensureBranchExists('main');
 * // Branch is now available locally for operations
 */
export function ensureBranchExists(branchName, workingDir = process.cwd()) {
  try {
    // Check if branch exists locally
    if (checkBranchExists(branchName, workingDir)) {
      verboseLog({}, chalk.gray(`Branch '${branchName}' exists locally`));
      return;
    }

    verboseLog({}, chalk.yellow(`Branch '${branchName}' not found locally, attempting to fetch...`));

    // Try to fetch the branch from origin
    try {
      execGitSafe('git fetch', ['origin', `${branchName}:${branchName}`], { stdio: 'pipe', cwd: workingDir });
      verboseLog({}, chalk.green(`Successfully fetched branch '${branchName}' from origin`));
    }
    catch {
      // If direct fetch fails, try fetching all branches and then checking
      verboseLog({}, chalk.yellow(`Direct fetch failed, trying to fetch all branches...`));
      execSync('git fetch origin', { stdio: 'pipe', cwd: workingDir });

      // Check if branch exists on remote
      try {
        execGitSafe('git show-ref', ['--verify', '--quiet', `refs/remotes/origin/${branchName}`], { cwd: workingDir });
        // Create local tracking branch without switching working tree.
        execGitSafe('git branch', ['--track', branchName, `origin/${branchName}`], { stdio: 'pipe', cwd: workingDir });
        verboseLog({}, chalk.green(`Successfully created local branch '${branchName}' tracking origin/${branchName}`));
      }
      catch {
        throw new Error(`Branch '${branchName}' not found locally or on remote origin`);
      }
    }
  }
  catch (error) {
    console.error(chalk.red(`Error ensuring branch '${branchName}' exists:`), error.message);
    throw error;
  }
}

/**
 * Find the base branch (main or master) that exists in the repository
 *
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 * @returns {string} The name of the base branch (main, master, or develop)
 *
 * @example
 * const baseBranch = findBaseBranch();
 * console.log(`Using base branch: ${baseBranch}`);
 */
export function findBaseBranch(workingDir = process.cwd()) {
  const candidateBranches = ['main', 'master', 'develop'];

  for (const branch of candidateBranches) {
    if (checkBranchExists(branch, workingDir)) {
      return branch;
    }

    // Also check if it exists on remote
    try {
      execGitSafe('git show-ref', ['--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: workingDir });
      return branch;
    }
    catch {
      // Branch doesn't exist on remote either, continue to next candidate
    }
  }

  // Fallback to HEAD~1 if no standard base branch found
  console.warn(chalk.yellow('No standard base branch (main/master/develop) found, using HEAD~1 as fallback'));
  return 'HEAD~1';
}

/**
 * Resolve a usable git ref for a branch, preferring a local ref and falling
 * back to the origin remote ref. Returns null if neither resolves.
 *
 * @param {string} branchName - Short branch name (e.g. 'feature-x')
 * @param {string} workingDir - Directory to run git commands in
 * @returns {string|null} A resolvable ref ('feature-x' or 'origin/feature-x'), or null
 */
function resolveBranchRef(branchName, workingDir = process.cwd()) {
  // HEAD (including detached HEAD) resolves directly as a rev; never fall through
  // to refs/remotes/origin/HEAD, which would point at the remote's default branch.
  if (branchName === 'HEAD') {
    return 'HEAD';
  }
  if (checkBranchExists(branchName, workingDir)) {
    return branchName;
  }
  try {
    execGitSafe('git show-ref', ['--verify', '--quiet', `refs/remotes/origin/${branchName}`], { cwd: workingDir });
    return `origin/${branchName}`;
  }
  catch {
    return null;
  }
}

/**
 * List candidate branches (local heads + origin remotes), mapping each short
 * name to a resolvable ref. Local refs are preferred over remote ones, and
 * 'origin/HEAD' is skipped.
 *
 * @param {string} workingDir - Directory to run git commands in
 * @returns {Map<string, string>} short branch name -> resolvable ref
 */
function listCandidateBranches(workingDir = process.cwd()) {
  const output = execGitSafe('git for-each-ref', ['--format=%(refname:short)', 'refs/heads/', 'refs/remotes/origin/'], {
    cwd: workingDir,
  }).toString();

  const candidates = new Map();
  for (const raw of output.split('\n')) {
    const refShort = raw.trim();
    if (!refShort) {
      continue;
    }

    const isRemote = refShort.startsWith('origin/');
    const shortName = isRemote ? refShort.slice('origin/'.length) : refShort;
    if (shortName === 'HEAD') {
      continue;
    }

    // Prefer a local ref over the remote one for the same short name.
    if (!candidates.has(shortName) || !isRemote) {
      candidates.set(shortName, refShort);
    }
  }

  return candidates;
}

/**
 * Detect the parent branch a target branch was forked from.
 *
 * Git does not record branch parentage, so this infers it heuristically. A valid
 * base must be an *ancestor* of the target (the target contains all of its
 * commits); among those ancestors, the one the target is fewest commits ahead of
 * is the nearest ancestor and therefore the most likely parent. This correctly
 * resolves stacked PRs (e.g. main -> feature-A -> feature-B detects feature-A as
 * feature-B's parent) while still selecting main/master/develop for ordinary
 * feature branches.
 *
 * The ancestor requirement is what makes the heuristic safe: branches that
 * forked *from* the target (e.g. a child branch off the middle of the target's
 * history) are not ancestors of the target, so they are excluded and can never
 * win on target-side distance alone and silently produce a wrong diff. Branches
 * with unrelated history are likewise skipped. When ties occur, a standard base
 * branch (main/master/develop) is preferred for stability. If no ancestor parent
 * can be inferred, it falls back to {@link findBaseBranch}.
 *
 * Deliberate trade-off (do not "fix" by ranking on target-side distance alone):
 * if the real parent has advanced beyond the point where the target forked (it
 * has commits the target lacks), it is no longer an ancestor and is skipped;
 * detection then falls back to the nearest stable ancestor (e.g. main). That
 * over-includes the parent's extra commits in the review but never omits any of
 * the target's own commits — the safe direction. Recovering the advanced parent
 * is impossible from topology alone (an advanced parent and a branch forked from
 * the middle of the target are indistinguishable in the commit graph; only the
 * target's local creation reflog can tell them apart, and that is absent in CI),
 * so this case is intentionally left to fall back rather than risk silently
 * hiding the target's commits.
 *
 * @param {string} targetBranch - The branch being reviewed
 * @param {string} workingDir - Directory to run git commands in (optional, defaults to cwd)
 * @returns {string} The detected parent/base branch name
 *
 * @example
 * const parent = findParentBranch('feature-B');
 * // -> 'feature-A' when feature-B was stacked on feature-A
 */
export function findParentBranch(targetBranch, workingDir = process.cwd()) {
  try {
    const targetRef = resolveBranchRef(targetBranch, workingDir) ?? targetBranch;

    const preferred = ['main', 'master', 'develop'];
    let best = null; // { name, ahead, isPreferred }

    for (const [shortName, ref] of listCandidateBranches(workingDir)) {
      if (shortName === targetBranch) {
        continue;
      }

      // A valid base must be an ancestor of the target. This excludes branches
      // that forked from the target (which have commits the target lacks) and
      // branches with unrelated history -- either would otherwise be picked on
      // target-side distance alone and hide commits from the diff.
      try {
        execGitSafe('git merge-base', ['--is-ancestor', ref, targetRef], { cwd: workingDir });
      }
      catch {
        continue; // Not an ancestor of the target: not a candidate parent.
      }

      // Commits the target has beyond this ancestor; the nearest ancestor
      // (fewest such commits) is the most likely parent.
      const ahead = parseInt(
        execGitSafe('git rev-list', ['--count', `${ref}..${targetRef}`], { cwd: workingDir })
          .toString()
          .trim(),
        10
      );
      if (!Number.isFinite(ahead) || ahead === 0) {
        continue; // Even with the target (same tip): not a parent.
      }

      const isPreferred = preferred.includes(shortName);
      if (best === null || ahead < best.ahead || (ahead === best.ahead && isPreferred && !best.isPreferred)) {
        best = { name: shortName, ahead, isPreferred };
      }
    }

    if (best) {
      verboseLog({}, chalk.gray(`Detected parent branch '${best.name}' for '${targetBranch}' (${best.ahead} commit(s) ahead)`));
      return best.name;
    }
  }
  catch (error) {
    verboseLog({}, chalk.yellow(`Parent branch detection failed (${error.message}); falling back to base branch detection`));
  }

  // Nothing closer found: fall back to the standard base branch heuristic.
  return findBaseBranch(workingDir);
}

/**
 * Get git diff content for a specific file between two branches/commits
 *
 * @param {string} filePath - Path to the file
 * @param {string} baseBranch - Base branch (e.g., 'main', 'master')
 * @param {string} targetBranch - Target branch (e.g., 'feature-branch')
 * @param {string} workingDir - Working directory for git commands
 * @returns {string} Git diff content for the file
 *
 * @example
 * const diff = getFileDiff('src/utils.js', 'main', 'feature-branch');
 * console.log('Changes:', diff);
 */
function getFileDiff(filePath, baseBranch, targetBranch, workingDir = process.cwd()) {
  try {
    // Use safely escaped args to avoid command injection.
    const diffOutput = execGitSafe('git diff', [`${baseBranch}...${targetBranch}`, '--', filePath], { cwd: workingDir, encoding: 'utf8' });

    return diffOutput;
  }
  catch (error) {
    console.error(chalk.red(`Error getting git diff for ${filePath}: ${error.message}`));
    return '';
  }
}

/**
 * Get changed lines info for a file between two branches
 *
 * @param {string} filePath - Path to the file
 * @param {string} baseBranch - Base branch
 * @param {string} targetBranch - Target branch
 * @param {string} workingDir - Working directory for git commands
 * @returns {Object} Object with added/removed lines info
 *
 * @example
 * const changes = getChangedLinesInfo('src/utils.js', 'main', 'feature-branch');
 * console.log(`Added ${changes.addedLines.length} lines, removed ${changes.removedLines.length} lines`);
 */
export function getChangedLinesInfo(filePath, baseBranch, targetBranch, workingDir = process.cwd()) {
  try {
    const diffOutput = getFileDiff(filePath, baseBranch, targetBranch, workingDir);

    if (!diffOutput) {
      return { hasChanges: false, addedLines: [], removedLines: [], contextLines: [] };
    }

    const { addedLines, removedLines, contextLines } = parseDiffLineInfo(diffOutput);

    return {
      hasChanges: addedLines.length > 0 || removedLines.length > 0,
      addedLines,
      removedLines,
      contextLines,
      fullDiff: diffOutput,
    };
  }
  catch (error) {
    console.error(chalk.red(`Error parsing diff for ${filePath}: ${error.message}`));
    return { hasChanges: false, addedLines: [], removedLines: [], contextLines: [] };
  }
}

/**
 * Get the content of a file from a specific git branch/commit without checking it out
 *
 * @param {string} filePath - Absolute path to the file in the repository
 * @param {string} branchOrCommit - The branch or commit hash to get the file from
 * @param {string} workingDir - The git repository directory
 * @returns {string} The content of the file
 *
 * @example
 * const content = getFileContentFromGit('/path/to/file.js', 'main', '/repo');
 * console.log('File content from main branch:', content);
 */
export function getFileContentFromGit(filePath, branchOrCommit, workingDir) {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd: workingDir }).toString().trim();
    const relativePath = path.relative(gitRoot, filePath);
    // Use forward slashes for git path
    const gitPath = relativePath.split(path.sep).join('/');

    // Command: git show <branch>:<path>
    // Use safe execution to prevent command injection
    return execGitSafe('git show', [`${branchOrCommit}:${gitPath}`], { cwd: workingDir, encoding: 'utf8' });
  }
  catch (error) {
    // Handle cases where the file might not exist in that commit (e.g., a new file in a feature branch)
    if (error.stderr && error.stderr.includes('exists on disk, but not in')) {
      // This case can be ignored if we are sure the file is new.
      // For a robust solution, you might need to check file status (new, modified, deleted).
      // For now, we return an empty string, assuming it's a new file not yet in the base.
      return '';
    }
    // Re-throw other errors
    throw new Error(`Failed to get content of ${filePath} from ${branchOrCommit}: ${error.message}`);
  }
}
