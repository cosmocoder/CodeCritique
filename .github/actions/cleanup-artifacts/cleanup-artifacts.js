#!/usr/bin/env node
/**
 * Cleanup Artifacts Script
 * Main execution script for the cleanup-artifacts action
 */

import fs from 'node:fs';

/**
 * Artifact name patterns mapped by cleanup type
 */
export const ARTIFACT_PATTERNS = {
  embeddings: ['ai-code-review-embeddings-'],
  models: ['ai-model-cache-', 'ai-fastembed-cache-'],
  feedback: ['ai-review-feedback-'],
  reports: ['ai-review-report-'],
  all: ['ai-code-review-embeddings-', 'ai-model-cache-', 'ai-fastembed-cache-', 'ai-review-feedback-', 'ai-review-report-'],
};

/**
 * Get artifact patterns for a cleanup type
 * @param {string} cleanupType - The cleanup type
 * @param {string} [customPattern] - Optional custom pattern to add
 * @returns {string[]}
 */
export function getArtifactPatterns(cleanupType, customPattern = '') {
  const patterns = [...(ARTIFACT_PATTERNS[cleanupType] || [])];

  if (customPattern && customPattern.trim()) {
    patterns.push(customPattern.trim());
  }

  return patterns;
}

/**
 * Check if an artifact matches any of the patterns
 * @param {string} artifactName - Name of the artifact
 * @param {string[]} patterns - Patterns to match against
 * @returns {boolean}
 */
export function artifactMatchesPatterns(artifactName, patterns) {
  return patterns.some((pattern) => artifactName.includes(pattern));
}

/**
 * Check if an artifact matches any exclude patterns
 * @param {string} artifactName - Name of the artifact
 * @param {string} excludePatterns - Comma-separated exclude patterns
 * @returns {{ excluded: boolean, matchedPattern: string | null }}
 */
export function artifactMatchesExcludePatterns(artifactName, excludePatterns) {
  if (!excludePatterns || !excludePatterns.trim()) {
    return { excluded: false, matchedPattern: null };
  }

  const patterns = excludePatterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const pattern of patterns) {
    if (artifactName.includes(pattern)) {
      return { excluded: true, matchedPattern: pattern };
    }
  }

  return { excluded: false, matchedPattern: null };
}

/**
 * Check if an artifact is older than the specified cutoff time
 * @param {string} createdAt - ISO timestamp of when artifact was created
 * @param {number} olderThanDays - Number of days threshold
 * @param {number} [currentTime] - Current timestamp in milliseconds (for testing)
 * @returns {boolean}
 */
export function isArtifactOlderThan(createdAt, olderThanDays, currentTime = Date.now()) {
  if (olderThanDays <= 0) {
    return true; // No age filter, consider all artifacts
  }

  const artifactTime = new Date(createdAt).getTime();
  const cutoffTime = currentTime - olderThanDays * 24 * 60 * 60 * 1000;

  return artifactTime < cutoffTime;
}

/**
 * Filter artifacts based on cleanup criteria
 * @param {Object[]} artifacts - Array of artifact objects
 * @param {Object} options - Filter options
 * @param {string[]} options.patterns - Patterns to match
 * @param {string} options.excludePatterns - Comma-separated exclude patterns
 * @param {number} options.olderThanDays - Age filter
 * @param {number} options.maxArtifacts - Maximum artifacts to process
 * @param {number} [options.currentTime] - Current timestamp for testing
 * @returns {{ toDelete: Object[], skipped: Object[], limitReached: boolean }}
 */
export function filterArtifacts(artifacts, options) {
  const { patterns, excludePatterns, olderThanDays, maxArtifacts, currentTime } = options;

  const toDelete = [];
  const skipped = [];
  let limitReached = false;

  for (const artifact of artifacts) {
    if (toDelete.length >= maxArtifacts) {
      limitReached = true;
      break;
    }

    // Skip expired artifacts
    if (artifact.expired === true) {
      skipped.push({ artifact, reason: 'expired' });
      continue;
    }

    // Check pattern match
    if (!artifactMatchesPatterns(artifact.name, patterns)) {
      skipped.push({ artifact, reason: 'no_pattern_match' });
      continue;
    }

    // Check exclude patterns
    const excludeCheck = artifactMatchesExcludePatterns(artifact.name, excludePatterns);
    if (excludeCheck.excluded) {
      skipped.push({ artifact, reason: 'excluded', pattern: excludeCheck.matchedPattern });
      continue;
    }

    // Check age
    if (!isArtifactOlderThan(artifact.created_at, olderThanDays, currentTime)) {
      skipped.push({ artifact, reason: 'too_recent' });
      continue;
    }

    toDelete.push(artifact);
  }

  return { toDelete, skipped, limitReached };
}

/**
 * Generate cleanup summary message
 * @param {Object} results - Cleanup results
 * @param {number} results.artifactsDeleted - Number of artifacts deleted
 * @param {number} results.spaceReclaimedMb - Space reclaimed in MB
 * @param {number} results.errorsCount - Number of errors
 * @param {boolean} results.dryRun - Whether this was a dry run
 * @returns {string}
 */
export function generateSummary(results) {
  const { artifactsDeleted, spaceReclaimedMb, errorsCount, dryRun } = results;

  let summary = dryRun
    ? `[DRY RUN] Would delete ${artifactsDeleted} artifacts, reclaiming ~${spaceReclaimedMb}MB`
    : `Deleted ${artifactsDeleted} artifacts, reclaimed ~${spaceReclaimedMb}MB`;

  if (errorsCount > 0) {
    summary += ` (${errorsCount} errors)`;
  }

  return summary;
}

/**
 * Create cleanup report object
 * @param {Object} options - Report options
 * @param {string} options.repository - Target repository
 * @param {string} options.cleanupType - Cleanup type
 * @param {number} options.olderThanDays - Age filter
 * @param {boolean} options.dryRun - Whether this was a dry run
 * @param {Object} options.results - Cleanup results
 * @returns {Object}
 */
export function createCleanupReport(options) {
  const { repository, cleanupType, olderThanDays, dryRun, results } = options;

  return {
    cleanup_metadata: {
      timestamp: new Date().toISOString(),
      repository,
      cleanup_type: cleanupType,
      older_than_days: olderThanDays,
      dry_run: dryRun,
    },
    results: {
      artifacts_processed: results.artifactsProcessed,
      artifacts_deleted: results.artifactsDeleted,
      space_reclaimed_mb: results.spaceReclaimedMb,
      errors_count: results.errorsCount,
    },
    artifacts_found: results.artifactsFound || [],
    artifacts_deleted: results.deletedArtifacts || [],
    errors: results.errors || [],
  };
}

/**
 * Calculate artifact size in MB
 * @param {number} sizeInBytes - Size in bytes
 * @returns {number} Size in MB (rounded)
 */
export function bytesToMb(sizeInBytes) {
  return Math.round(sizeInBytes / 1024 / 1024);
}

// Read inputs from environment variables
const cleanupType = process.env.INPUT_CLEANUP_TYPE || 'all';
const olderThanDays = parseInt(process.env.INPUT_OLDER_THAN_DAYS || '30', 10);
const repository = process.env.INPUT_REPOSITORY || process.env.GITHUB_REPOSITORY;
const dryRun = process.env.INPUT_DRY_RUN === 'true';
const requireConfirmation = process.env.INPUT_REQUIRE_CONFIRMATION === 'true';
const customPattern = process.env.INPUT_ARTIFACT_NAME_PATTERN || '';
const excludePatterns = process.env.INPUT_EXCLUDE_PATTERNS || '';
const maxArtifactsPerRun = parseInt(process.env.INPUT_MAX_ARTIFACTS_PER_RUN || '50', 10);
const verbose = process.env.INPUT_VERBOSE === 'true';
const generateReport = process.env.INPUT_GENERATE_REPORT !== 'false';
const githubToken = process.env.GITHUB_TOKEN;

// GitHub Actions output file
const outputFile = process.env.GITHUB_OUTPUT;

/**
 * Append output to GitHub Actions output file
 */
function setOutput(name, value) {
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
  console.log(`::set-output name=${name}::${value}`);
}

/**
 * Fetch artifacts from GitHub API
 */
async function fetchArtifacts() {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts?per_page=100`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch artifacts: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.artifacts || [];
}

/**
 * Delete an artifact via GitHub API
 */
async function deleteArtifact(artifactId) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  return response.ok;
}

/**
 * Main cleanup function
 */
async function runCleanup() {
  console.log('🗑️ Starting artifact cleanup process...');

  // Initialize counters
  let artifactsDeleted = 0;
  let artifactsProcessed = 0;
  let spaceReclaimed = 0;
  let errorsCount = 0;
  const failedDeletions = [];
  const deletedArtifacts = [];
  const artifactsFound = [];
  const errors = [];

  const reportPath = `cleanup-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;

  // Get artifact patterns using the utility function
  const patterns = getArtifactPatterns(cleanupType, customPattern);
  console.log(`🔍 Searching for artifacts matching patterns: ${patterns.join(', ')}`);

  // Fetch artifacts from GitHub API
  console.log(`📦 Fetching artifacts from repository: ${repository}`);
  let artifacts;
  try {
    artifacts = await fetchArtifacts();
  } catch (error) {
    console.error(`❌ Failed to fetch artifacts: ${error.message}`);
    setOutput('artifacts-deleted', '0');
    setOutput('space-reclaimed', '0');
    setOutput('summary', `Error: ${error.message}`);
    setOutput('errors-count', '1');
    setOutput('failed-deletions', '');
    setOutput('artifacts-processed', '0');
    setOutput('report-path', reportPath);
    process.exit(1);
  }

  if (!artifacts || artifacts.length === 0) {
    console.log('📝 No artifacts found in repository');
    setOutput('artifacts-deleted', '0');
    setOutput('space-reclaimed', '0');
    setOutput('summary', 'No artifacts found to cleanup');
    setOutput('errors-count', '0');
    setOutput('failed-deletions', '');
    setOutput('artifacts-processed', '0');
    setOutput('report-path', reportPath);
    process.exit(0);
  }

  // Filter artifacts using the utility function
  const { toDelete, skipped, limitReached } = filterArtifacts(artifacts, {
    patterns,
    excludePatterns,
    olderThanDays,
    maxArtifacts: maxArtifactsPerRun,
    currentTime: Date.now(),
  });

  if (limitReached) {
    console.log(`⚠️ Reached maximum artifacts per run limit (${maxArtifactsPerRun})`);
  }

  // Log skipped artifacts in verbose mode
  if (verbose) {
    for (const { artifact, reason, pattern } of skipped) {
      if (reason === 'expired') {
        console.log(`⏭️ Skipping expired artifact: ${artifact.name}`);
      } else if (reason === 'excluded') {
        console.log(`⏭️ Excluding artifact matching pattern '${pattern}': ${artifact.name}`);
      } else if (reason === 'too_recent') {
        console.log(`⏭️ Skipping recent artifact: ${artifact.name} (created: ${artifact.created_at})`);
      }
    }
  }

  // Process artifacts to delete
  for (const artifact of toDelete) {
    artifactsProcessed++;
    const sizeMb = bytesToMb(artifact.size_in_bytes || 0);

    console.log(`🎯 Found matching artifact: ${artifact.name} (ID: ${artifact.id}, Size: ${sizeMb}MB)`);
    artifactsFound.push({ ...artifact, matched: true });

    if (dryRun) {
      console.log(`🔍 [DRY RUN] Would delete artifact: ${artifact.name}`);
      artifactsDeleted++;
      spaceReclaimed += sizeMb;
    } else {
      if (requireConfirmation) {
        // In CI, confirmation isn't practical - skip confirmation logic
        console.log(`❓ Confirmation required for: ${artifact.name} (skipped in non-interactive mode)`);
        continue;
      }

      console.log(`🗑️ Deleting artifact: ${artifact.name}`);

      const success = await deleteArtifact(artifact.id);
      if (success) {
        console.log(`✅ Successfully deleted: ${artifact.name}`);
        artifactsDeleted++;
        spaceReclaimed += sizeMb;
        deletedArtifacts.push({ ...artifact, deleted: true });
      } else {
        console.log(`❌ Failed to delete: ${artifact.name}`);
        failedDeletions.push(artifact.name);
        errors.push({
          artifact_name: artifact.name,
          error: 'deletion_failed',
          message: 'API call failed',
        });
        errorsCount++;
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Generate summary using utility function
  const summary = generateSummary({
    artifactsDeleted,
    spaceReclaimedMb: spaceReclaimed,
    errorsCount,
    dryRun,
  });

  console.log(`📊 Cleanup Summary: ${summary}`);

  // Generate report if enabled
  if (generateReport) {
    const report = createCleanupReport({
      repository,
      cleanupType,
      olderThanDays,
      dryRun,
      results: {
        artifactsProcessed,
        artifactsDeleted,
        spaceReclaimedMb: spaceReclaimed,
        errorsCount,
        artifactsFound,
        deletedArtifacts,
        errors,
      },
    });

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }

  // Set outputs
  setOutput('artifacts-deleted', artifactsDeleted.toString());
  setOutput('space-reclaimed', spaceReclaimed.toString());
  setOutput('summary', summary);
  setOutput('errors-count', errorsCount.toString());
  setOutput('failed-deletions', failedDeletions.join(','));
  setOutput('artifacts-processed', artifactsProcessed.toString());
  setOutput('report-path', reportPath);
}

// Run the cleanup
runCleanup().catch((error) => {
  console.error(`❌ Cleanup failed: ${error.message}`);
  process.exit(1);
});
