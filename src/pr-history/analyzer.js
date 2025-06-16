/**
 * Main PR History Analyzer
 *
 * Orchestrates the complete PR comment history analysis workflow using
 * GitHub API client, comment processor, and database storage.
 */

import { clearPRComments, getPRCommentsStats, getProcessedPRDateRange, shouldSkipPR, storePRCommentsBatch } from './database.js';
import { GitHubAPIClient } from './github-client.js';
import { PRCommentProcessor } from './comment-processor.js';
import chalk from 'chalk';

/**
 * Progress tracking for PR analysis
 */
class PRAnalysisProgress {
  constructor(repository) {
    this.repository = repository;
    this.progress = {
      repository,
      total_prs: 0,
      processed_prs: 0,
      total_comments: 0,
      processed_comments: 0,
      failed_comments: 0,
      last_processed_pr: null,
      last_processed_page: 0,
      start_time: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      errors: [],
      status: 'not_started', // 'not_started', 'in_progress', 'completed', 'failed'
    };
  }

  async save() {
    this.progress.last_updated = new Date().toISOString();
  }

  async load() {
    return false;
  }

  updatePRs(total, processed) {
    this.progress.total_prs = total;
    this.progress.processed_prs = processed;
  }

  updateComments(total, processed, failed = 0) {
    this.progress.total_comments = total;
    this.progress.processed_comments = processed;
    this.progress.failed_comments = failed;
  }

  setLastProcessed(prNumber, page = 0) {
    this.progress.last_processed_pr = prNumber;
    this.progress.last_processed_page = page;
  }

  addError(error, context = '') {
    this.progress.errors.push({
      error: error.message,
      context,
      timestamp: new Date().toISOString(),
    });
  }

  setStatus(status) {
    this.progress.status = status;
  }

  getProgressSummary() {
    return {
      repository: this.progress.repository,
      status: this.progress.status,
      prs: `${this.progress.processed_prs}/${this.progress.total_prs}`,
      comments: `${this.progress.processed_comments}/${this.progress.total_comments}`,
      failed_comments: this.progress.failed_comments,
      errors: this.progress.errors.length,
      elapsed: this.getElapsedTime(),
    };
  }

  getElapsedTime() {
    const start = new Date(this.progress.start_time);
    const now = new Date();
    const elapsed = now - start;
    const hours = Math.floor(elapsed / (1000 * 60 * 60));
    const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
  }
}

/**
 * Main PR History Analyzer class
 */
export class PRHistoryAnalyzer {
  constructor(options = {}) {
    this.githubClient = null;
    this.commentProcessor = new PRCommentProcessor();
    this.progress = null;
    this.options = {
      concurrency: 2,
      batchSize: 50,
      skipDependabot: true,
      includeDrafts: false,
      ...options,
    };
  }

  /**
   * Initialize the analyzer with GitHub client
   * @param {string} token - GitHub API token
   */
  initialize(token) {
    this.githubClient = new GitHubAPIClient({
      token,
      requestTimeout: 30000,
      retries: 3,
      concurrency: this.options.concurrency,
    });
  }

  /**
   * Analyze PR comment history for a repository
   * @param {string} repository - Repository in format "owner/repo"
   * @param {Object} options - Analysis options
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeRepository(repository, options = {}) {
    const {
      since = null,
      until = null,
      limit = null,
      resume = false,
      clearExisting = false,
      onProgress = null,
      projectPath = process.cwd(),
    } = options;

    // Initialize progress tracking
    this.progress = new PRAnalysisProgress(repository);

    // Load existing progress if resuming
    if (resume) {
      const loaded = await this.progress.load();
      if (loaded && this.progress.progress.status === 'completed') {
        console.log(chalk.green(`Analysis for ${repository} already completed.`));
        return await this.getAnalysisResults(repository, projectPath);
      }
    }

    // Clear existing data if requested
    if (clearExisting) {
      console.log(chalk.yellow(`Clearing existing PR comments for ${repository}...`));
      await clearPRComments(repository, projectPath);
    }

    try {
      this.progress.setStatus('in_progress');
      await this.progress.save();

      console.log(chalk.blue(`Starting PR comment analysis for ${repository}`));
      console.log(chalk.blue(`Options: concurrency=${this.options.concurrency}, batchSize=${this.options.batchSize}`));

      // Step 1: Fetch all merged PRs
      const prs = await this.fetchAllPRs(repository, { since, until, limit, resume, onProgress, projectPath });

      if (prs.length === 0) {
        console.log(chalk.yellow(`No merged PRs found for ${repository}`));
        this.progress.setStatus('completed');
        await this.progress.save();
        return { repository, total_prs: 0, total_comments: 0, patterns: [] };
      }

      console.log(chalk.green(`Found ${prs.length} merged PRs to analyze`));
      this.progress.updatePRs(prs.length, 0);

      // Step 2: Process PR comments
      const processedComments = await this.processPRComments(prs, { onProgress, projectPath });

      // Step 3: Store in database
      if (processedComments.length > 0) {
        console.log(chalk.blue(`Storing ${processedComments.length} processed comments in database...`));
        const storedCount = await storePRCommentsBatch(processedComments, projectPath);
        console.log(chalk.green(`Successfully stored ${storedCount} PR comments`));
      }

      // Step 4: Generate final results
      const results = await this.getAnalysisResults(repository, projectPath);

      this.progress.setStatus('completed');
      await this.progress.save();

      console.log(chalk.green(`Analysis completed for ${repository}`));
      console.log(chalk.green(`Processed ${results.total_prs} PRs with ${results.total_comments} comments`));

      return results;
    } catch (error) {
      console.error(chalk.red(`Error analyzing repository ${repository}: ${error.message}`));
      this.progress.addError(error, 'Repository analysis');
      this.progress.setStatus('failed');
      await this.progress.save();
      throw error;
    }
  }

  /**
   * Fetch all merged PRs from repository
   * @private
   * @param {string} repository - Repository in format "owner/repo"
   * @param {Object} options - Fetch options
   * @returns {Promise<Array>} Array of PRs
   */
  async fetchAllPRs(repository, options = {}) {
    const { since, until, limit, resume, onProgress, projectPath = process.cwd() } = options;
    const [owner, repo] = repository.split('/');

    console.log(chalk.blue(`Fetching merged PRs for ${repository}...`));

    try {
      const startPage = resume ? this.progress.progress.last_processed_page + 1 : 1;

      // Enable incremental updates by default unless explicit since/until dates are provided
      const shouldUseIncremental = !since && !until && !resume;

      const prs = await this.githubClient.fetchAllPRs(owner, repo, {
        since,
        until,
        limit,
        startPage,
        skipDependabot: this.options.skipDependabot,
        includeDrafts: this.options.includeDrafts,
        incremental: shouldUseIncremental,
        projectPath,
        onProgress: (pageProgress) => {
          this.progress.setLastProcessed(null, pageProgress.page);
          if (onProgress) {
            onProgress({
              stage: 'fetching_prs',
              current: pageProgress.page,
              total: pageProgress.estimatedPages || pageProgress.page,
              message: `Fetching PR page ${pageProgress.page}`,
            });
          }
        },
      });

      return prs.filter((pr) => pr.merged_at); // Ensure only merged PRs
    } catch (error) {
      console.error(chalk.red(`Error fetching PRs: ${error.message}`));
      this.progress.addError(error, 'Fetching PRs');
      throw error;
    }
  }

  /**
   * Process comments for all PRs
   * @private
   * @param {Array} prs - Array of PR objects
   * @param {Object} options - Processing options
   * @returns {Promise<Array>} Array of processed comments
   */
  async processPRComments(prs, options = {}) {
    const { onProgress, projectPath = process.cwd() } = options;
    const allProcessedComments = [];
    let totalComments = 0;
    let processedComments = 0;
    let failedComments = 0;

    console.log(chalk.blue(`Processing comments for ${prs.length} PRs...`));
    console.log(chalk.cyan(`This may take several minutes for large repositories...`));

    // Get processed PR date range to skip already processed PRs
    console.log(chalk.blue(`Checking for already processed PRs...`));
    const { oldestPR, newestPR } = await getProcessedPRDateRange(this.progress.repository, projectPath);

    let skippedPRs = 0;
    let prsToProcess = prs;

    if (oldestPR && newestPR) {
      console.log(chalk.blue(`Found processed PR range: ${oldestPR} to ${newestPR}`));
      prsToProcess = prs.filter((pr) => {
        const shouldSkip = shouldSkipPR(pr, oldestPR, newestPR);
        if (shouldSkip) {
          skippedPRs++;
        }
        return !shouldSkip;
      });
      console.log(chalk.green(`Skipping ${skippedPRs} already processed PRs, processing ${prsToProcess.length} new PRs`));
    } else {
      console.log(chalk.blue(`No previously processed PRs found, processing all ${prs.length} PRs`));
    }

    if (prsToProcess.length === 0) {
      console.log(chalk.yellow(`All PRs have already been processed!`));
      return allProcessedComments;
    }

    // First pass: count total comments for better progress tracking
    console.log(chalk.blue(`Counting total comments across ${prsToProcess.length} PRs to process...`));
    let estimatedComments = 0;
    for (let i = 0; i < Math.min(prsToProcess.length, 10); i++) {
      estimatedComments += (prsToProcess[i].comments || 0) + (prsToProcess[i].review_comments || 0);
    }
    const avgCommentsPerPR = estimatedComments / Math.min(prsToProcess.length, 10);
    const totalEstimatedComments = Math.floor(avgCommentsPerPR * prsToProcess.length);
    console.log(chalk.blue(`Estimated ${totalEstimatedComments} total comments to process`));

    // Process PRs in batches
    for (let i = 0; i < prsToProcess.length; i += this.options.batchSize) {
      const batch = prsToProcess.slice(i, i + this.options.batchSize);
      const batchNumber = Math.floor(i / this.options.batchSize) + 1;
      const totalBatches = Math.ceil(prsToProcess.length / this.options.batchSize);

      console.log(
        chalk.blue(
          `Processing PR batch ${batchNumber}/${totalBatches} (PRs ${i + 1}-${Math.min(i + this.options.batchSize, prsToProcess.length)})`
        )
      );

      const batchStartTime = Date.now();

      // Process PRs in parallel within batch
      const batchPromises = batch.map(async (pr, batchIndex) => {
        try {
          const prIndex = i + batchIndex;
          const prComments = await this.processSinglePR(pr);

          this.progress.setLastProcessed(pr.number);
          this.progress.updatePRs(prsToProcess.length, prIndex + 1);

          if (onProgress) {
            onProgress({
              stage: 'processing_comments',
              current: prIndex + 1,
              total: prsToProcess.length,
              message: `Processed PR #${pr.number} (${prComments.length} comments)`,
            });
          }

          return prComments;
        } catch (error) {
          console.error(chalk.red(`Error processing PR #${pr.number}: ${error.message}`));
          this.progress.addError(error, `PR #${pr.number}`);
          return [];
        }
      });

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);

      // Flatten and collect results
      let batchCommentCount = 0;
      for (const prComments of batchResults) {
        totalComments += prComments.length;
        const validComments = prComments.filter((comment) => comment !== null);
        processedComments += validComments.length;
        failedComments += prComments.length - validComments.length;
        allProcessedComments.push(...validComments);
        batchCommentCount += prComments.length;
      }

      const batchDuration = (Date.now() - batchStartTime) / 1000;
      console.log(
        chalk.blue(`Batch ${batchNumber}/${totalBatches} completed: ${batchCommentCount} comments in ${batchDuration.toFixed(1)}s`)
      );
      console.log(
        chalk.blue(
          `Progress: ${processedComments}/${totalEstimatedComments} comments processed (${((processedComments / totalEstimatedComments) * 100).toFixed(1)}%)`
        )
      );

      this.progress.updateComments(totalComments, processedComments, failedComments);
      await this.progress.save();

      // Small delay between batches to be gentle on APIs
      if (i + this.options.batchSize < prsToProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(chalk.green(`Processed ${processedComments}/${totalComments} comments from ${prsToProcess.length} PRs`));
    if (skippedPRs > 0) {
      console.log(chalk.blue(`Skipped ${skippedPRs} already processed PRs`));
    }
    if (failedComments > 0) {
      console.log(chalk.yellow(`Failed to process ${failedComments} comments`));
    }

    return allProcessedComments;
  }

  /**
   * Process comments for a single PR
   * @private
   * @param {Object} pr - PR object
   * @returns {Promise<Array>} Array of processed comments
   */
  async processSinglePR(pr) {
    try {
      const [owner, repo] = this.progress.repository.split('/');

      // Fetch all types of comments for this PR
      const fetchStartTime = Date.now();
      const [reviewComments, issueComments, prFiles] = await Promise.all([
        this.githubClient.getPRReviewComments(owner, repo, pr.number),
        this.githubClient.getPRIssueComments(owner, repo, pr.number),
        this.githubClient.getPRFiles(owner, repo, pr.number),
      ]);
      const fetchDuration = (Date.now() - fetchStartTime) / 1000;

      // Combine all comments
      const allComments = [
        ...reviewComments.map((comment) => ({ ...comment, type: 'review' })),
        ...issueComments.map((comment) => ({ ...comment, type: 'issue' })),
      ];

      if (allComments.length === 0) {
        return [];
      }

      // Create PR context
      const prContext = {
        pr: {
          number: pr.number,
          repository: this.progress.repository,
        },
        files: prFiles,
      };

      // Process comments using comment processor
      const processedComments = await this.commentProcessor.processBatch(allComments, prContext);
      return processedComments;
    } catch (error) {
      console.error(chalk.red(`Error processing PR #${pr.number}: ${error.message}`));
      throw error;
    }
  }

  /**
   * Get analysis results from database
   * @private
   * @param {string} repository - Repository name
   * @param {string} projectPath - Project path for filtering (optional, defaults to cwd)
   * @returns {Promise<Object>} Analysis results
   */
  async getAnalysisResults(repository, projectPath = process.cwd()) {
    try {
      const stats = await getPRCommentsStats(repository, projectPath);

      // Ensure stats has the expected structure
      const safeStats = {
        total_comments: stats?.total_comments || 0,
        comment_types: stats?.comment_types || {},
        issue_categories: stats?.issue_categories || {},
        severity_levels: stats?.severity_levels || {},
        authors: stats?.authors || {},
        repositories: stats?.repositories || {},
      };

      // Extract patterns from statistics
      const patterns = [];

      // Add comment type patterns
      try {
        for (const [type, count] of Object.entries(safeStats.comment_types)) {
          patterns.push({
            type: 'comment_type',
            name: type,
            count,
            percentage: safeStats.total_comments > 0 ? ((count / safeStats.total_comments) * 100).toFixed(1) : '0.0',
          });
        }
      } catch (error) {
        console.warn(chalk.yellow(`Error processing comment type patterns: ${error.message}`));
      }

      // Add issue category patterns
      try {
        for (const [category, count] of Object.entries(safeStats.issue_categories)) {
          patterns.push({
            type: 'issue_category',
            name: category,
            count,
            percentage: safeStats.total_comments > 0 ? ((count / safeStats.total_comments) * 100).toFixed(1) : '0.0',
          });
        }
      } catch (error) {
        console.warn(chalk.yellow(`Error processing issue category patterns: ${error.message}`));
      }

      // Add severity patterns
      try {
        for (const [severity, count] of Object.entries(safeStats.severity_levels)) {
          patterns.push({
            type: 'severity',
            name: severity,
            count,
            percentage: safeStats.total_comments > 0 ? ((count / safeStats.total_comments) * 100).toFixed(1) : '0.0',
          });
        }
      } catch (error) {
        console.warn(chalk.yellow(`Error processing severity patterns: ${error.message}`));
      }

      // Calculate total PRs safely
      let totalPRs = 0;
      try {
        const repoValues = Object.values(safeStats.repositories);
        totalPRs = repoValues.length > 0 ? Math.max(...repoValues) : 0;
      } catch (error) {
        console.warn(chalk.yellow(`Error calculating total PRs: ${error.message}`));
        totalPRs = 0;
      }

      // Calculate top authors safely
      let topAuthors = [];
      try {
        topAuthors = Object.entries(safeStats.authors)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([author, count]) => ({ author, count }));
      } catch (error) {
        console.warn(chalk.yellow(`Error calculating top authors: ${error.message}`));
        topAuthors = [];
      }

      return {
        repository,
        total_prs: totalPRs,
        total_comments: safeStats.total_comments,
        comment_types: safeStats.comment_types,
        issue_categories: safeStats.issue_categories,
        severity_levels: safeStats.severity_levels,
        top_authors: topAuthors,
        patterns,
        analysis_date: new Date().toISOString(),
      };
    } catch (error) {
      console.error(chalk.red(`Error getting analysis results: ${error.message}`));
      return {
        repository,
        total_prs: 0,
        total_comments: 0,
        patterns: [],
        error: error.message,
      };
    }
  }

  /**
   * Resume interrupted analysis
   * @param {string} repository - Repository name
   * @param {Object} options - Resume options
   * @returns {Promise<Object>} Analysis results
   */
  async resumeAnalysis(repository, options = {}) {
    return this.analyzeRepository(repository, { ...options, resume: true });
  }

  /**
   * Get progress status for repository
   * @param {string} repository - Repository name
   * @returns {Promise<Object>} Progress status
   */
  async getProgressStatus(repository) {
    const progress = new PRAnalysisProgress(repository);
    const loaded = await progress.load();

    if (!loaded) {
      return { repository, status: 'not_started' };
    }

    return progress.getProgressSummary();
  }
}

/**
 * Convenience function to analyze a repository
 * @param {string} repository - Repository in format "owner/repo"
 * @param {string} token - GitHub API token
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} Analysis results
 */
export async function analyzePRHistory(repository, token, options = {}) {
  const analyzer = new PRHistoryAnalyzer(options);
  analyzer.initialize(token);
  return analyzer.analyzeRepository(repository, options);
}

/**
 * Get status of PR analysis for repository
 * @param {string} repository - Repository name
 * @returns {Promise<Object>} Status information
 */
export async function getPRAnalysisStatus(repository) {
  const analyzer = new PRHistoryAnalyzer();
  return analyzer.getProgressStatus(repository);
}
