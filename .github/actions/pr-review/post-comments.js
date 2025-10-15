/**
 * GitHub PR Comment Posting Script
 * Posts CodeCritique Review comments to PR using GitHub API
 */

import fs from 'fs';
import path from 'path';
import { shouldSkipSimilarIssue, loadFeedbackData } from '../../../src/feedback-loader.js';

/**
 * Main function for posting CodeCritique review comments to GitHub Pull Requests.
 *
 * Features:
 * - Posts inline code review comments with feedback tracking
 * - Analyzes user feedback (reactions, replies) for conversation auto-resolution
 * - Implements feedback-aware filtering to prevent reposting dismissed suggestions
 * - Manages comment lifecycle (creation, preservation, cleanup)
 * - Supports fallback to general PR comments when inline comments fail
 * - Generates summary comments with analysis metrics
 * - Saves feedback artifacts for cross-workflow learning
 *
 * @param {Object} params - GitHub Actions context and tools
 * @param {Object} params.github - GitHub API client (Octokit)
 * @param {Object} params.context - GitHub Actions workflow context
 * @param {Object} params.core - GitHub Actions core utilities for outputs/logging
 *
 * @async
 * @function
 * @returns {Promise<void>} Resolves when comment posting is complete
 *
 * @throws {Error} If comment posting fails, sets action as failed with error message
 *
 * @example
 * // Called automatically by GitHub Actions
 * await postComments({ github, context, core });
 */
export default async ({ github, context, core }) => {
  try {
    // Configuration constants
    const postComments = true;
    const summaryComment = true;
    const maxComments = 25;
    const trackFeedback = true;

    // Get remaining environment variables
    const reviewOutputPath = process.env.REVIEW_OUTPUT_PATH;

    console.log(`💬 Processing review results for PR #${context.issue.number}`);

    const analyzeFeedback = async (commentId, commentBody = '') => {
      if (!trackFeedback) return null;

      try {
        // Determine if this is a review comment or issue comment
        const isReviewComment = commentBody !== '';

        // Check for user reactions
        const reactions = isReviewComment
          ? await github.rest.reactions.listForPullRequestReviewComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: commentId,
            })
          : await github.rest.reactions.listForIssueComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: commentId,
            });

        // Analyze reactions for feedback
        const positiveReactions = reactions.data.filter((r) => ['+1', 'heart', 'hooray'].includes(r.content)).length;
        const negativeReactions = reactions.data.filter((r) => ['-1', 'confused', 'eyes'].includes(r.content)).length;

        // Get subsequent comments to check for replies
        const allComments = isReviewComment
          ? await github.rest.pulls.listReviewComments({
              pull_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
            })
          : await github.rest.issues.listComments({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
            });

        const dismissiveKeywords = ['disagree', 'not relevant', 'false positive', 'ignore', 'resolved'];
        let userReplies = [];

        if (isReviewComment) {
          // For review comments, find threaded replies using in_reply_to_id
          userReplies = allComments.data.filter(
            (c) =>
              c.in_reply_to_id === commentId &&
              c.user.login !== 'github-actions[bot]' &&
              dismissiveKeywords.some((keyword) => c.body.toLowerCase().includes(keyword))
          );
        } else {
          // For issue comments, find replies within 5 comments after the AI comment
          const commentIndex = allComments.data.findIndex((c) => c.id === commentId);
          const potentialReplies = allComments.data.slice(commentIndex + 1, commentIndex + 6);
          userReplies = potentialReplies.filter(
            (c) => c.user.login !== 'github-actions[bot]' && dismissiveKeywords.some((keyword) => c.body.toLowerCase().includes(keyword))
          );
        }

        // Check if user provided dismissive feedback
        const hasDismissiveFeedback = userReplies.length > 0 || negativeReactions > positiveReactions;

        // Auto-resolve conversation if user provided dismissive feedback
        if (hasDismissiveFeedback && isReviewComment) {
          try {
            console.log(`🔧 Auto-resolving conversation for comment ${commentId} due to dismissive feedback`);

            // First, get the review thread information to get the thread ID
            const threadQuery = `
              query($owner: String!, $repo: String!, $number: Int!) {
                repository(owner: $owner, name: $repo) {
                  pullRequest(number: $number) {
                    reviewThreads(first: 100) {
                      nodes {
                        id
                        comments(first: 1) {
                          nodes {
                            databaseId
                          }
                        }
                        isResolved
                      }
                    }
                  }
                }
              }
            `;

            const threadData = await github.graphql(threadQuery, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              number: context.issue.number,
            });

            // Find the thread that contains our comment
            const thread = threadData.repository.pullRequest.reviewThreads.nodes.find((t) =>
              t.comments.nodes.some((c) => c.databaseId === parseInt(commentId))
            );

            if (thread && !thread.isResolved) {
              // Post acknowledgment comment
              await github.rest.pulls.createReplyForReviewComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: context.issue.number,
                comment_id: commentId,
                body: '✅ **Conversation resolved based on user feedback**\n\n*This suggestion has been marked as resolved due to user feedback indicating it should be ignored.*',
              });

              // Resolve the conversation thread
              const resolveMutation = `
                mutation($threadId: ID!) {
                  resolveReviewThread(input: { threadId: $threadId }) {
                    thread {
                      id
                      isResolved
                    }
                  }
                }
              `;

              await github.graphql(resolveMutation, {
                threadId: thread.id,
              });

              console.log(`✅ Successfully resolved conversation thread for comment ${commentId}`);
            } else if (thread && thread.isResolved) {
              console.log(`ℹ️ Conversation thread for comment ${commentId} is already resolved`);
            } else {
              console.log(`⚠️ Could not find review thread for comment ${commentId}`);
            }
          } catch (resolveError) {
            console.log(`⚠️ Could not auto-resolve conversation for comment ${commentId}: ${resolveError.message}`);
          }
        }

        return {
          commentId,
          positiveReactions,
          negativeReactions,
          userReplies: userReplies.map((r) => ({
            user: r.user.login,
            body: r.body.substring(0, 200), // First 200 chars for context
            createdAt: r.created_at,
          })),
          overallSentiment:
            positiveReactions > negativeReactions ? 'positive' : negativeReactions > positiveReactions ? 'negative' : 'neutral',
          contextAdded: hasDismissiveFeedback,
        };
      } catch (error) {
        console.log(`⚠️ Error analyzing feedback for comment ${commentId}: ${error.message}`);
        return null;
      }
    };

    const saveFeedbackData = async (feedbackData) => {
      if (!trackFeedback || Object.keys(feedbackData).length === 0) return;

      try {
        // Create feedback report
        const feedbackReport = {
          prNumber: context.issue.number,
          runId: context.runId,
          timestamp: new Date().toISOString(),
          feedback: feedbackData,
          summary: {
            totalComments: Object.keys(feedbackData).length,
            positiveCount: Object.values(feedbackData).filter((f) => f?.overallSentiment === 'positive').length,
            negativeCount: Object.values(feedbackData).filter((f) => f?.overallSentiment === 'negative').length,
            repliesCount: Object.values(feedbackData).reduce((acc, f) => acc + (f?.userReplies?.length || 0), 0),
            contextAddedCount: Object.values(feedbackData).filter((f) => f?.contextAdded).length,
          },
        };

        // Save to both locations: .ai-feedback for CLI and tool root for upload
        const toolRoot = process.env.REVIEW_OUTPUT_PATH ? path.dirname(process.env.REVIEW_OUTPUT_PATH) : '.';
        const feedbackDir = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), '.ai-feedback');
        const feedbackFileName = `feedback-${context.issue.number}-${Date.now()}.json`;

        // Ensure feedback directory exists
        if (!fs.existsSync(feedbackDir)) {
          fs.mkdirSync(feedbackDir, { recursive: true });
        }

        // Save to .ai-feedback for CLI to find
        const feedbackPath = path.join(feedbackDir, feedbackFileName);
        // Also save to tool root for artifact upload
        const uploadPath = path.join(toolRoot, feedbackFileName);

        const feedbackJson = JSON.stringify(feedbackReport, null, 2);
        fs.writeFileSync(feedbackPath, feedbackJson);
        fs.writeFileSync(uploadPath, feedbackJson);

        console.log(`💾 Saved feedback data to ${feedbackPath} (for CLI)`);
        console.log(`💾 Saved feedback data to ${uploadPath} (for upload)`);
        core.setOutput('feedback-artifact-uploaded', 'true');
        core.setOutput('feedback-report-path', uploadPath);

        return feedbackReport;
      } catch (error) {
        console.log(`⚠️ Error saving feedback data: ${error.message}`);
        core.setOutput('feedback-artifact-uploaded', 'false');
        return null;
      }
    };

    // Load existing feedback data
    const feedbackDir = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), '.ai-feedback');
    const existingFeedback = await loadFeedbackData(feedbackDir, { verbose: true });
    const currentFeedback = {};

    // Check if review output exists
    if (!fs.existsSync(reviewOutputPath)) {
      console.log('❌ Review output file not found');
      return;
    }

    // Read and parse review results
    const reviewData = JSON.parse(fs.readFileSync(reviewOutputPath, 'utf8'));
    const uniqueCommentId = '<!-- codecritique-review-action -->';

    console.log('✅ JSON file is valid');

    const totalIssues = reviewData.summary?.totalIssues || 0;

    console.log(`📊 Parsing results: ${totalIssues} issues found`);

    // Get PR information
    const { data: pull } = await github.rest.pulls.get({
      pull_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
    });

    const commitId = pull.head.sha;

    // Find existing summary comment to update
    let existingSummaryCommentId = null;
    if (summaryComment) {
      console.log('🔍 Looking for existing summary comment to update...');

      const { data: prComments } = await github.rest.issues.listComments({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
      });

      const botComment = prComments.find(
        (comment) => comment.body.includes(uniqueCommentId) && comment.user.login === 'github-actions[bot]'
      );

      if (botComment) {
        existingSummaryCommentId = botComment.id;
        console.log(`🔄 Found existing summary comment ID: ${existingSummaryCommentId}`);
      } else {
        console.log('➕ No existing summary comment found, will create new one');
      }
    }

    // Fetch CodeCritique review comments once to avoid race conditions
    let botReviewComments = [];
    if (postComments) {
      console.log('🔍 Fetching CodeCritique review comments...');

      const { data: reviewComments } = await github.rest.pulls.listReviewComments({
        pull_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
      });

      // Filter to only include comments made by this specific CodeCritique tool
      botReviewComments = reviewComments.filter(
        (comment) => comment.body.includes(uniqueCommentId) && comment.user.login === 'github-actions[bot]'
      );

      console.log(
        `📊 Found ${botReviewComments.length} existing CodeCritique comments (filtered from ${reviewComments.length} total comments)`
      );
    }

    // Analyze feedback from previous comments before cleanup
    if (postComments && trackFeedback && botReviewComments.length > 0) {
      console.log('📊 Analyzing feedback from previous CodeCritique comments...');

      // Analyze feedback for each existing comment with retry logic
      for (const comment of botReviewComments) {
        let feedback = null;
        let retryCount = 0;
        const maxRetries = 2;

        while (!feedback && retryCount <= maxRetries) {
          try {
            feedback = await analyzeFeedback(comment.id, comment.body);
            if (feedback) {
              // Store original issue description for similarity matching
              const reviewHeaderMatch = comment.body.match(/\*\*CodeCritique Review\*\*\s*\n\n(.*?)(?:\n\n|\*\*|$)/s);
              feedback.originalIssue = reviewHeaderMatch ? reviewHeaderMatch[1].trim() : comment.body.substring(0, 100);
              currentFeedback[comment.id] = feedback;
              console.log(`📝 Collected feedback for comment ${comment.id}: ${feedback.overallSentiment}`);
            } else if (retryCount < maxRetries) {
              console.log(`⚠️ Feedback analysis failed for comment ${comment.id}, retrying...`);
              // Add exponential backoff delay
              await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
            } else {
              console.log(`❌ Failed to analyze feedback for comment ${comment.id} after ${maxRetries + 1} attempts`);
              // Create a minimal feedback entry to prevent deletion
              currentFeedback[comment.id] = {
                commentId: comment.id,
                positiveReactions: 0,
                negativeReactions: 0,
                userReplies: [],
                overallSentiment: 'unknown',
                contextAdded: false,
                analysisError: true,
              };
            }
          } catch (error) {
            console.log(`⚠️ Error analyzing feedback for comment ${comment.id} (attempt ${retryCount + 1}): ${error.message}`);
            if (retryCount === maxRetries) {
              // Preserve comment on analysis failure
              currentFeedback[comment.id] = {
                commentId: comment.id,
                positiveReactions: 0,
                negativeReactions: 0,
                userReplies: [],
                overallSentiment: 'unknown',
                contextAdded: false,
                analysisError: true,
              };
            }
          }
          retryCount++;
        }
      }

      console.log(`📊 Collected feedback from ${Object.keys(currentFeedback).length} previous comments`);
    }

    // Delete previous line comments (but preserve ones with user feedback)
    if (postComments && botReviewComments.length > 0) {
      console.log('🔄 Cleaning up previous CodeCritique line comments...');

      let deletedCount = 0;
      let preservedCount = 0;
      let failedDeletions = [];

      for (const comment of botReviewComments) {
        // Check if this comment has user feedback - if so, preserve it
        const commentFeedback = currentFeedback[comment.id];
        const hasUserInteraction =
          commentFeedback &&
          !commentFeedback.analysisError &&
          (commentFeedback.userReplies.length > 0 || commentFeedback.positiveReactions > 0 || commentFeedback.negativeReactions > 0);

        // Also preserve comments where analysis failed to be safe
        const preserveOnError = commentFeedback?.analysisError;

        if (hasUserInteraction || preserveOnError) {
          const reason = preserveOnError ? 'failed analysis (safety)' : 'user feedback';
          console.log(`📌 Preserving comment ${comment.id} due to ${reason}`);
          preservedCount++;
        } else {
          // No user interaction - safe to delete
          let deleteAttempts = 0;
          let deleted = false;

          while (!deleted && deleteAttempts < 2) {
            try {
              await github.rest.pulls.deleteReviewComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: comment.id,
              });
              deletedCount++;
              deleted = true;
            } catch (deleteError) {
              deleteAttempts++;
              if (deleteAttempts === 1) {
                // Retry once after a short delay
                console.log(`⚠️ Delete attempt 1 failed for comment ${comment.id}, retrying...`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } else {
                console.log(`❌ Could not delete comment ${comment.id} after 2 attempts: ${deleteError.message}`);
                failedDeletions.push({ commentId: comment.id, error: deleteError.message });
              }
            }
          }
        }
      }

      if (failedDeletions.length > 0) {
        console.log(`⚠️ Warning: ${failedDeletions.length} comments could not be deleted. They may be duplicated in the next run.`);
        // Log failed deletions for debugging
        failedDeletions.forEach((failure) => {
          console.log(`   Comment ${failure.commentId}: ${failure.error}`);
        });
      }

      console.log(`🗑️ Deleted ${deletedCount} comments without user feedback`);
      console.log(`📌 Preserved ${preservedCount} comments with user feedback`);
    }

    // Post or update summary comment
    if (summaryComment) {
      const summaryBody = `## 🤖 CodeCritique Review Summary

**Files Analyzed:** ${reviewData.summary?.totalFilesReviewed || 'N/A'}
**Issues Found:** ${totalIssues}

${
  totalIssues > 0
    ? `### 📋 Review Results

The AI has identified potential improvements in your code. Please review the inline comments for detailed feedback.`
    : `### ✅ No Issues Found

Great job! The AI review didn't identify any significant issues with your changes.`
}

*Review was enhanced with codebase context using cached embeddings.*

${uniqueCommentId}`;

      if (existingSummaryCommentId) {
        console.log('📝 Updating existing summary comment...');
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existingSummaryCommentId,
          body: summaryBody,
        });
        console.log('✅ Updated existing summary comment');
      } else {
        console.log('📋 Creating new summary comment...');
        await github.rest.issues.createComment({
          issue_number: context.issue.number,
          owner: context.repo.owner,
          repo: context.repo.repo,
          body: summaryBody,
        });
        console.log('✅ Created new summary comment');
      }
    }

    // Post inline comments
    if (postComments && totalIssues > 0) {
      console.log('💬 Processing inline comments...');

      let commentsPosted = 0;
      const details = reviewData.details || [];

      console.log(`Found ${details.length} result items to display`);

      for (const fileDetail of details) {
        if (commentsPosted >= maxComments) {
          console.log(`📊 Reached maximum comment limit (${maxComments})`);
          break;
        }

        if (!fileDetail.review?.issues) continue;

        // Convert absolute path to relative path
        let relativePath = fileDetail.filePath;

        // Handle GitHub Actions runner path format: /home/runner/_work/dash/dash/...
        if (relativePath.includes('/_work/')) {
          const parts = relativePath.split('/_work/')[1].split('/');
          if (parts.length >= 3) {
            relativePath = parts.slice(2).join('/');
          }
        }

        // Remove leading slashes
        relativePath = relativePath.replace(/^\/+/, '');

        console.log(`📁 Processing ${fileDetail.filePath} -> ${relativePath}`);

        for (const issue of fileDetail.review.issues) {
          if (commentsPosted >= maxComments) break;

          // Skip similar issues that received negative feedback
          if (
            shouldSkipSimilarIssue(issue.description, existingFeedback, {
              similarityThreshold: 0.7,
              verbose: true,
            })
          ) {
            console.log(`⏭️ Skipping similar issue based on previous feedback: ${issue.description.substring(0, 50)}...`);
            continue;
          }

          const lineNum = issue.lineNumbers?.[0] || 1;
          const severity = issue.severity || 'info';
          const emoji = severity === 'error' ? '🚨' : severity === 'warning' ? '⚠️' : severity === 'medium' ? '⚠️' : '💡';

          let commentBody = `${emoji} **CodeCritique Review**

*Severity: ${severity}*

${issue.description}`;

          if (issue.suggestion) {
            commentBody += `

**Suggestion:**
${issue.suggestion}`;
          }

          // Add feedback tracking notice if enabled
          if (trackFeedback) {
            commentBody += `

*💬 React with 👍/👎 or reply with "ignore" or "false positive" to prevent similar comments in future runs on this PR.*`;
          }

          commentBody += `

${uniqueCommentId}`;

          console.log(`📍 Posting comment for ${relativePath}:${lineNum}`);

          try {
            // Try posting as inline comment
            await github.rest.pulls.createReviewComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.issue.number,
              commit_id: commitId,
              path: relativePath,
              line: lineNum,
              body: commentBody,
            });

            commentsPosted++;
            console.log(`✅ Posted inline comment for ${relativePath}:${lineNum}`);
          } catch (error) {
            console.log(`⚠️ Failed to post inline comment for ${relativePath}:${lineNum}: ${error.message}`);

            // Fallback to general PR comment
            try {
              await github.rest.issues.createComment({
                issue_number: context.issue.number,
                owner: context.repo.owner,
                repo: context.repo.repo,
                body: `**File: \`${relativePath}\` (Line ${lineNum})**

${commentBody}`,
              });

              commentsPosted++;
              console.log(`✅ Posted fallback comment for ${relativePath}`);
            } catch (fallbackError) {
              console.log(`❌ Failed to post fallback comment for ${relativePath}: ${fallbackError.message}`);
            }
          }
        }
      }

      console.log(`📊 Posted ${commentsPosted} inline comments`);

      // Set output for GitHub Actions
      core.setOutput('comments-posted', commentsPosted.toString());
    } else {
      console.log('⏭️ No inline comments to post');
      core.setOutput('comments-posted', '0');
    }

    // Save feedback data for future runs
    if (trackFeedback && Object.keys(currentFeedback).length > 0) {
      console.log('💾 Saving feedback data for future reviews...');
      const feedbackReport = await saveFeedbackData(currentFeedback);

      if (feedbackReport) {
        console.log(`📊 Feedback Summary:`);
        console.log(`  - Total feedback items: ${feedbackReport.summary.totalComments}`);
        console.log(`  - Positive reactions: ${feedbackReport.summary.positiveCount}`);
        console.log(`  - Negative reactions: ${feedbackReport.summary.negativeCount}`);
        console.log(`  - User replies: ${feedbackReport.summary.repliesCount}`);
        console.log(`  - Resolution context added: ${feedbackReport.summary.contextAddedCount}`);
      }
    }

    console.log('✅ Comment posting completed');
  } catch (error) {
    console.error('❌ Error in comment posting script:', error.message);
    core.setFailed(`Comment posting failed: ${error.message}`);
  }
};
