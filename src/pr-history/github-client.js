/**
 * GitHub API Client for PR History Analysis
 *
 * Provides comprehensive GitHub API integration for fetching complete PR history
 * with intelligent pagination, filtering, and rate limiting for large repositories.
 */

import { getLastAnalysisTimestamp } from './database.js';
import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';

// Configuration constants
const DEFAULT_PER_PAGE = 100;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000; // 1 second
const RATE_LIMIT_BUFFER = 100; // Keep 100 requests in reserve
const PROGRESS_SAVE_INTERVAL = 10; // Save progress every 10 PRs

/**
 * GitHub API Client with comprehensive PR fetching capabilities
 */
export class GitHubAPIClient {
  constructor(options = {}) {
    this.token = options.token || process.env.GITHUB_TOKEN;

    // Only validate token if we're not injecting a mock Octokit
    if (!options.octokit) {
      this.validateToken();
    }

    // Allow injection of Octokit instance for testing
    this.octokit =
      options.octokit ||
      new Octokit({
        auth: this.token,
        userAgent: 'ai-code-review-pr-history/1.0.0',
        request: {
          timeout: 30000, // 30 second timeout
        },
      });

    this.rateLimitInfo = null;
    this.progressCallback = options.progressCallback || null;
    this.resumeFile = options.resumeFile || null;
    this.debug = options.debug || false;
  }

  /**
   * Validate GitHub token exists and has proper format
   */
  validateToken() {
    if (!this.token) {
      throw new Error('GitHub token required. Set GITHUB_TOKEN environment variable or pass token option.');
    }

    // Basic token format validation
    if (!this.token.match(/^gh[ps]_[a-zA-Z0-9]{36,}$/)) {
      console.warn(chalk.yellow('Warning: Token format appears invalid. Expected GitHub token format.'));
    }
  }

  /**
   * Test token permissions for a specific repository
   */
  async testTokenPermissions(owner, repo) {
    try {
      await this.octokit.repos.get({ owner, repo });
      this.log(`✓ Token has access to ${owner}/${repo}`);
      return true;
    } catch (error) {
      if (error.status === 403) {
        throw new Error(`Token lacks permission to access repository ${owner}/${repo}`);
      } else if (error.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found or not accessible`);
      }
      throw error;
    }
  }

  /**
   * Get the last analysis date for a repository to enable incremental updates
   */
  async getLastAnalysisDate(owner, repo, projectPath) {
    try {
      const lastTimestamp = await getLastAnalysisTimestamp(`${owner}/${repo}`, projectPath);

      if (lastTimestamp) {
        this.log(`Last analysis found: ${lastTimestamp}`);
        return new Date(lastTimestamp);
      }

      this.log('No previous analysis found');
      return null;
    } catch (error) {
      this.log(`Error getting last analysis date: ${error.message}`, 'warn');
      return null;
    }
  }

  /**
   * Calculate incremental date range for efficient fetching
   */
  calculateIncrementalRange(lastAnalysisDate, options = {}) {
    const { forceFullRefresh = false, bufferDays = 7 } = options;

    if (forceFullRefresh || !lastAnalysisDate) {
      this.log('Using full refresh mode');
      return {
        since: options.since || null,
        until: options.until || null,
        incremental: false,
        reason: forceFullRefresh ? 'force refresh requested' : 'no previous analysis',
      };
    }

    // Add buffer days to account for updated PRs
    const bufferDate = new Date(lastAnalysisDate);
    bufferDate.setDate(bufferDate.getDate() - bufferDays);

    // Use the earlier of buffer date or explicit since date
    const effectiveSince = options.since ? new Date(Math.min(new Date(options.since), bufferDate)) : bufferDate;

    this.log(`Incremental update from ${effectiveSince.toISOString()} (${bufferDays} day buffer)`);

    return {
      since: effectiveSince.toISOString(),
      until: options.until || null,
      incremental: true,
      reason: `incremental from ${lastAnalysisDate.toISOString()} with ${bufferDays} day buffer`,
    };
  }

  /**
   * Resume analysis from last saved position
   */
  async resumeFromLastPosition(owner, repo, projectPath) {
    try {
      const progress = await this.loadProgress(true);

      if (!progress.prs || progress.prs.length === 0) {
        this.log('No resume data found, starting fresh');
        return null;
      }

      // Get the last processed PR date for incremental calculation
      const lastPRDate = progress.prs.reduce((latest, pr) => {
        const prDate = new Date(pr.merged_at || pr.updated_at);
        return prDate > latest ? prDate : latest;
      }, new Date(0));

      this.log(`Resume data found: ${progress.prs.length} PRs, last date: ${lastPRDate.toISOString()}`);

      return {
        prs: progress.prs,
        lastPage: progress.lastPage || 1,
        lastDate: lastPRDate,
        totalProcessed: progress.totalProcessed || 0,
      };
    } catch (error) {
      this.log(`Error loading resume data: ${error.message}`, 'warn');
      return null;
    }
  }

  /**
   * Detect changed PRs since last analysis for delta processing
   */
  async detectChangedPRs(owner, repo, prList, lastAnalysisDate) {
    if (!lastAnalysisDate || !Array.isArray(prList)) {
      return prList; // Return all PRs if no baseline
    }

    const changedPRs = prList.filter((pr) => {
      const updatedDate = new Date(pr.updated_at);
      const mergedDate = new Date(pr.merged_at || pr.updated_at);

      // Include if updated or merged after last analysis
      return updatedDate > lastAnalysisDate || mergedDate > lastAnalysisDate;
    });

    this.log(`Delta processing: ${changedPRs.length} changed PRs out of ${prList.length} total`);
    return changedPRs;
  }

  /**
   * Fetch all merged PRs from a repository with intelligent pagination and incremental support
   */
  async fetchAllPRs(owner, repo, options = {}) {
    const {
      since = null,
      until = null,
      limit = null,
      skipDependabot = true,
      includeDrafts = false,
      resume = false,
      incremental = false,
      projectPath = null,
    } = options;

    // Handle incremental updates
    let effectiveOptions = { ...options };
    if (incremental && projectPath) {
      this.log('Performing incremental analysis...');
      const lastAnalysisDate = await this.getLastAnalysisDate(owner, repo, projectPath);
      const incrementalRange = this.calculateIncrementalRange(lastAnalysisDate, options);

      effectiveOptions = {
        ...options,
        since: incrementalRange.since,
        until: incrementalRange.until,
      };

      this.log(`Incremental range: ${incrementalRange.reason}`);
    }

    // Load progress if resuming
    let progress = await this.loadProgress(resume);
    let allPRs = progress.prs || [];
    let page = progress.lastPage || 1;
    let totalProcessed = progress.totalProcessed || 0;

    this.log(`Starting PR fetch for ${owner}/${repo} from page ${page}`);

    // Test repository access
    await this.testTokenPermissions(owner, repo);

    let hasMore = true;
    const startTime = Date.now();

    while (hasMore) {
      try {
        const response = await this.callWithRetry(async () => {
          const apiParams = {
            owner,
            repo,
            state: 'closed',
            sort: 'updated',
            direction: 'desc',
            per_page: DEFAULT_PER_PAGE,
            page,
          };

          // Add since parameter to API call for efficient server-side filtering
          if (effectiveOptions.since) {
            apiParams.since = effectiveOptions.since;
          }

          return await this.octokit.pulls.list(apiParams);
        });

        let prs = response.data;

        // Apply filters (API since filters by updated_at, we still need client-side since for merged_at)
        prs = this.filterPRs(prs, {
          skipDependabot,
          includeDrafts,
          since: effectiveOptions.since, // Keep since filter for merged_at filtering
          until: effectiveOptions.until, // Keep until filter for upper bound
        });

        allPRs.push(...prs);
        totalProcessed += response.data.length; // Count all fetched PRs, not just filtered ones

        // Check stopping conditions
        if (response.data.length < DEFAULT_PER_PAGE) {
          hasMore = false;
          this.log('Reached end of PR list');
        } else if (limit && allPRs.length >= limit) {
          allPRs = allPRs.slice(0, limit);
          hasMore = false;
          this.log(`Reached limit of ${limit} PRs`);
        } else if (effectiveOptions.since && prs.length === 0 && response.data.length > 0) {
          // If we're using since filter and getting 0 results after filtering, we've likely reached the date boundary
          hasMore = false;
          this.log('Reached date boundary (no PRs match criteria), stopping fetch');
        }

        // Progress reporting - only log every 10 pages to reduce verbosity
        if (page % 10 === 0 || !hasMore) {
          const elapsedTime = (Date.now() - startTime) / 1000;
          const prsPerSecond = totalProcessed / elapsedTime;
          this.log(
            `Page ${page}: ${allPRs.length} PRs collected (rate: ${prsPerSecond.toFixed(1)} PRs/s, elapsed: ${elapsedTime.toFixed(1)}s)`
          );
        }

        if (this.progressCallback) {
          const elapsedTime = (Date.now() - startTime) / 1000;
          const prsPerSecond = totalProcessed / elapsedTime;
          const estimatedTotal = hasMore ? Math.ceil(allPRs.length * 1.5) : allPRs.length;

          this.progressCallback({
            type: 'pr_fetch',
            page,
            totalPRs: allPRs.length,
            processedPRs: totalProcessed,
            estimatedTotal,
            rateLimitRemaining: this.rateLimitInfo?.remaining,
            elapsedTime,
            prsPerSecond,
          });
        }

        // Save progress periodically
        if (page % PROGRESS_SAVE_INTERVAL === 0) {
          await this.saveProgress({
            prs: allPRs,
            lastPage: page,
            totalProcessed,
            repository: `${owner}/${repo}`,
            timestamp: new Date().toISOString(),
          });
        }

        page++;

        // Rate limiting
        await this.respectRateLimit();
      } catch (error) {
        this.log(`Error fetching page ${page}: ${error.message}`, 'error');
        throw error;
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    this.log(`Completed PR fetch: ${allPRs.length} PRs in ${duration.toFixed(2)}s`);

    // Save final progress
    await this.saveProgress({
      prs: allPRs,
      lastPage: page,
      totalProcessed,
      repository: `${owner}/${repo}`,
      completed: true,
      timestamp: new Date().toISOString(),
    });

    return allPRs;
  }

  /**
   * Filter PRs based on specified criteria
   */
  filterPRs(prs, options) {
    const { skipDependabot, includeDrafts, since, until } = options;

    return prs.filter((pr) => {
      // Only merged PRs
      if (!pr.merged_at) {
        return false;
      }

      // Skip Dependabot PRs if requested
      if (skipDependabot && this.isDependabotPR(pr)) {
        return false;
      }

      // Skip drafts if not included
      if (!includeDrafts && pr.draft) {
        return false;
      }

      // Date filtering
      const mergedDate = new Date(pr.merged_at);
      if (since && mergedDate < new Date(since)) {
        return false;
      }
      if (until && mergedDate > new Date(until)) {
        return false;
      }

      return true;
    });
  }

  /**
   * Check if PR is from Dependabot
   */
  isDependabotPR(pr) {
    const dependabotUsers = ['dependabot[bot]', 'dependabot-preview[bot]'];
    return dependabotUsers.includes(pr.user?.login?.toLowerCase());
  }

  /**
   * Determine if we should stop fetching based on date boundaries
   */
  shouldStopFetching(prs, options) {
    const { since } = options;

    if (!since || prs.length === 0) {
      return false;
    }

    // Check if all PRs in this batch are older than the since date
    const sinceDate = new Date(since);
    return prs.every((pr) => {
      const mergedDate = new Date(pr.merged_at);
      return mergedDate < sinceDate;
    });
  }

  /**
   * Fetch detailed PR information including comments and reviews
   */
  async fetchPRDetails(owner, repo, prNumber) {
    try {
      const [prDetails, reviewComments, issueComments, reviews, files] = await Promise.all([
        this.callWithRetry(() => this.octokit.pulls.get({ owner, repo, pull_number: prNumber })),
        this.callWithRetry(() => this.octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber })),
        this.callWithRetry(() => this.octokit.issues.listComments({ owner, repo, issue_number: prNumber })),
        this.callWithRetry(() => this.octokit.pulls.listReviews({ owner, repo, pull_number: prNumber })),
        this.callWithRetry(() => this.octokit.pulls.listFiles({ owner, repo, pull_number: prNumber })),
      ]);

      return {
        pr: prDetails.data,
        reviewComments: reviewComments.data,
        issueComments: issueComments.data,
        reviews: reviews.data,
        files: files.data,
      };
    } catch (error) {
      this.log(`Error fetching details for PR #${prNumber}: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Fetch PR review comments (inline code comments)
   */
  async getPRReviewComments(owner, repo, prNumber) {
    try {
      const response = await this.callWithRetry(() => this.octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber }));
      return response.data;
    } catch (error) {
      this.log(`Error fetching review comments for PR #${prNumber}: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Fetch PR issue comments (general discussion comments)
   */
  async getPRIssueComments(owner, repo, prNumber) {
    try {
      const response = await this.callWithRetry(() => this.octokit.issues.listComments({ owner, repo, issue_number: prNumber }));
      return response.data;
    } catch (error) {
      this.log(`Error fetching issue comments for PR #${prNumber}: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Fetch PR files (changed files in the PR)
   */
  async getPRFiles(owner, repo, prNumber) {
    try {
      const response = await this.callWithRetry(() => this.octokit.pulls.listFiles({ owner, repo, pull_number: prNumber }));
      return response.data;
    } catch (error) {
      this.log(`Error fetching files for PR #${prNumber}: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Make API call with retry logic and exponential backoff
   */
  async callWithRetry(apiCall, maxRetries = MAX_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await apiCall();

        // Update rate limit info
        if (result.headers) {
          this.updateRateLimitInfo(result.headers);
        }

        return result;
      } catch (error) {
        lastError = error;

        if (this.isRetryableError(error) && attempt < maxRetries) {
          const delay = this.calculateBackoffDelay(attempt, error);
          this.log(`Attempt ${attempt} failed, retrying in ${delay}ms: ${error.message}`, 'warn');
          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error) {
    return (
      error.status === 429 || // Rate limit
      error.status === 502 || // Bad gateway
      error.status === 503 || // Service unavailable
      error.status === 504 || // Gateway timeout
      error.status >= 500 || // Server errors
      error.code === 'ENOTFOUND' || // DNS errors
      error.code === 'ECONNRESET' || // Connection reset
      error.code === 'ETIMEDOUT' // Timeout
    );
  }

  /**
   * Calculate backoff delay with exponential increase
   */
  calculateBackoffDelay(attempt, error) {
    // For rate limiting, use reset time if available
    if (error.status === 429 && error.response?.headers['x-ratelimit-reset']) {
      const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
      const now = Date.now();
      const delay = Math.max(resetTime - now, BASE_RETRY_DELAY);
      return Math.min(delay, 60000); // Cap at 1 minute
    }

    // Exponential backoff for other errors
    return BASE_RETRY_DELAY * Math.pow(2, attempt - 1);
  }

  /**
   * Update rate limit information from response headers
   */
  updateRateLimitInfo(headers) {
    this.rateLimitInfo = {
      limit: parseInt(headers['x-ratelimit-limit']) || 0,
      remaining: parseInt(headers['x-ratelimit-remaining']) || 0,
      reset: parseInt(headers['x-ratelimit-reset']) || 0,
      used: parseInt(headers['x-ratelimit-used']) || 0,
    };
  }

  /**
   * Respect rate limits with intelligent delays
   */
  async respectRateLimit() {
    if (!this.rateLimitInfo) {
      return;
    }

    const { remaining, reset } = this.rateLimitInfo;

    // If we're running low on requests, add delay
    if (remaining < RATE_LIMIT_BUFFER) {
      const resetTime = reset * 1000;
      const now = Date.now();
      const delay = Math.max(resetTime - now, 1000);

      this.log(`Rate limit low (${remaining} remaining), waiting ${delay}ms`, 'warn');
      await this.sleep(delay);
    }
  }

  /**
   * Load progress from file for resume capability
   */
  async loadProgress(resume) {
    if (!resume || !this.resumeFile) {
      return {};
    }

    try {
      const progressData = await fs.readFile(this.resumeFile, 'utf8');
      const progress = JSON.parse(progressData);
      this.log(`Resuming from page ${progress.lastPage || 1}`);
      return progress;
    } catch (error) {
      this.log('No previous progress found, starting fresh');
      return {};
    }
  }

  /**
   * Save progress to file
   */
  async saveProgress(progress) {
    if (!this.resumeFile) {
      return;
    }

    try {
      await fs.mkdir(path.dirname(this.resumeFile), { recursive: true });
      await fs.writeFile(this.resumeFile, JSON.stringify(progress, null, 2));
    } catch (error) {
      this.log(`Failed to save progress: ${error.message}`, 'error');
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Logging with color support
   */
  log(message, level = 'info') {
    if (!this.debug && level === 'debug') {
      return;
    }

    const colors = {
      info: chalk.blue,
      warn: chalk.yellow,
      error: chalk.red,
      debug: chalk.cyan,
    };

    const colorFn = colors[level] || chalk.white;
    console.log(colorFn(`[GitHub Client] ${message}`));
  }
}

/**
 * Convenience function to create a GitHub client
 */
export function createGitHubClient(options = {}) {
  return new GitHubAPIClient(options);
}
