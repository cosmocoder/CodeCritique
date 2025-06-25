/**
 * Bot Detection Utility
 *
 * Detects and filters out bot comments from PR analysis.
 * Bots provide automated feedback that isn't useful for human review pattern analysis.
 */

/**
 * Common bot patterns found in GitHub usernames and comment content
 */
const BOT_PATTERNS = {
  // Username patterns
  usernames: [
    /\[bot\]$/i, // e.g., sonarqubecloud[bot], dependabot[bot]
    /^bot-/i, // e.g., bot-reviewer
    /-bot$/i, // e.g., review-bot
    /^dependabot/i, // Dependabot variations
    /^renovate/i, // Renovate bot variations
    /^github-actions/i, // GitHub Actions bot
    /^codecov/i, // Codecov bot
    /^sonarcloud/i, // SonarCloud variations
    /^sonarqube/i, // SonarQube variations
    /^snyk/i, // Snyk security bot
    /^greenkeeper/i, // Greenkeeper bot
    /^semantic-release/i, // Semantic release bot
    /^allcontributors/i, // All contributors bot
    /^stale/i, // Stale bot
    /^mergify/i, // Mergify bot
    /^auto-merge/i, // Auto-merge bots
    /^ci-bot/i, // CI bots
    /^deploy-bot/i, // Deploy bots
  ],
};

/**
 * Known bot usernames (exact matches)
 */
const KNOWN_BOTS = new Set([
  'dependabot[bot]',
  'renovate[bot]',
  'github-actions[bot]',
  'codecov[bot]',
  'sonarqubecloud[bot]',
  'sonarcloud[bot]',
  'snyk[bot]',
  'greenkeeper[bot]',
  'semantic-release-bot',
  'allcontributors[bot]',
  'stale[bot]',
  'mergify[bot]',
  'auto-merge-bot',
  'ci-bot',
  'deploy-bot',
  'vercel[bot]',
  'netlify[bot]',
  'heroku[bot]',
  'circleci[bot]',
  'travis[bot]',
  'jenkins[bot]',
  'azure-pipelines[bot]',
  'gitpod[bot]',
  'codesandbox[bot]',
  'deepsource[bot]',
  'codeclimate[bot]',
  'codebeat[bot]',
  'codacy[bot]',
  'houndci-bot',
  'danger[bot]',
  'prettier[bot]',
  'eslint[bot]',
  'typescript[bot]',
]);

/**
 * Check if a username indicates a bot account
 * @param {string} username - GitHub username to check
 * @returns {boolean} True if username appears to be a bot
 */
function isBotUsername(username) {
  if (!username || typeof username !== 'string') {
    return false;
  }

  const normalizedUsername = username.toLowerCase().trim();

  // Check exact matches first (most reliable)
  if (KNOWN_BOTS.has(username) || KNOWN_BOTS.has(normalizedUsername)) {
    return true;
  }

  // Check username patterns
  return BOT_PATTERNS.usernames.some((pattern) => pattern.test(username));
}

/**
 * Bot detection for a comment based only on username
 * @param {Object} comment - Comment object with user and body properties
 * @returns {boolean} True if comment appears to be from a bot
 */
function isBotComment(comment) {
  if (!comment) {
    return false;
  }

  // Only check username (most reliable indicator)
  const username = comment.user?.login || comment.author_login || comment.author;
  return username ? isBotUsername(username) : false;
}

/**
 * Filter out bot comments from an array of comments
 * @param {Array<Object>} comments - Array of comment objects
 * @returns {Array<Object>} Filtered array with bot comments removed
 */
export function filterBotComments(comments) {
  if (!Array.isArray(comments)) {
    return [];
  }

  const filtered = comments.filter((comment) => !isBotComment(comment));

  return filtered;
}
