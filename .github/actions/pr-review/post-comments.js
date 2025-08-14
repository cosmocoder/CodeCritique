/**
 * GitHub PR Comment Posting Script
 * Posts CodeCritique Review comments to PR using GitHub API
 */

import fs from 'fs';

export default async ({ github, context, core }) => {
  try {
    // Get environment variables
    const postComments = process.env.INPUT_POST_COMMENTS === 'true';
    const summaryComment = process.env.INPUT_SUMMARY_COMMENT === 'true';
    const maxComments = parseInt(process.env.INPUT_MAX_COMMENTS) || 25;
    const analysisTime = process.env.ANALYSIS_TIME || 'N/A';
    const reviewOutputPath = process.env.REVIEW_OUTPUT_PATH;
    const trackFeedback = process.env.INPUT_TRACK_FEEDBACK === 'true';
    const feedbackArtifactName = process.env.INPUT_FEEDBACK_ARTIFACT_NAME || 'review-feedback';

    console.log(`💬 Processing review results for PR #${context.issue.number}`);

    // Feedback tracking functions
    const loadFeedbackData = async () => {
      if (!trackFeedback) return {};

      try {
        // Try to load previous feedback from artifacts
        const { data: artifacts } = await github.rest.actions.listWorkflowRunArtifacts({
          owner: context.repo.owner,
          repo: context.repo.repo,
          run_id: context.runId,
        });

        const feedbackArtifact = artifacts.artifacts.find((a) => a.name === feedbackArtifactName);
        if (feedbackArtifact) {
          console.log(`📥 Found existing feedback artifact: ${feedbackArtifact.name}`);
          // In a real implementation, we would download and parse the artifact
          // For now, return empty object as GitHub API doesn't easily allow artifact download in actions
          return {};
        }

        console.log('📭 No previous feedback artifact found');
        return {};
      } catch (error) {
        console.log(`⚠️ Error loading feedback data: ${error.message}`);
        return {};
      }
    };

    const analyzeFeedback = async (commentId) => {
      if (!trackFeedback) return null;

      try {
        // Check for user reactions
        const { data: reactions } = await github.rest.reactions.listForIssueComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: commentId,
        });

        // Analyze reactions for feedback
        const positiveReactions = reactions.filter((r) => ['+1', 'heart', 'hooray'].includes(r.content)).length;
        const negativeReactions = reactions.filter((r) => ['-1', 'confused', 'eyes'].includes(r.content)).length;

        // Get subsequent comments to check for replies
        const { data: allComments } = await github.rest.issues.listComments({
          issue_number: context.issue.number,
          owner: context.repo.owner,
          repo: context.repo.repo,
        });

        // Find comments that might be replies (within 5 comments after the AI comment)
        const commentIndex = allComments.findIndex((c) => c.id === commentId);
        const potentialReplies = allComments.slice(commentIndex + 1, commentIndex + 6);

        const userReplies = potentialReplies.filter(
          (c) =>
            c.user.login !== 'github-actions[bot]' &&
            (c.body.toLowerCase().includes('disagree') ||
              c.body.toLowerCase().includes('not relevant') ||
              c.body.toLowerCase().includes('false positive') ||
              c.body.toLowerCase().includes('ignore') ||
              c.body.toLowerCase().includes('resolved'))
        );

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
          },
        };

        // Save to file for artifact upload
        const feedbackPath = `feedback-${context.issue.number}-${Date.now()}.json`;
        fs.writeFileSync(feedbackPath, JSON.stringify(feedbackReport, null, 2));

        console.log(`💾 Saved feedback data to ${feedbackPath}`);
        core.setOutput('feedback-artifact-uploaded', 'true');
        core.setOutput('feedback-report-path', feedbackPath);

        return feedbackReport;
      } catch (error) {
        console.log(`⚠️ Error saving feedback data: ${error.message}`);
        core.setOutput('feedback-artifact-uploaded', 'false');
        return null;
      }
    };

    const shouldSkipSimilarIssue = (issueDescription, feedbackData) => {
      if (!trackFeedback || !feedbackData) return false;

      // Check if similar issues were previously dismissed
      const dismissedIssues = Object.values(feedbackData).filter(
        (f) =>
          f?.overallSentiment === 'negative' ||
          f?.userReplies?.some((r) => r.body.toLowerCase().includes('false positive') || r.body.toLowerCase().includes('not relevant'))
      );

      // Simple similarity check (in production, might use more sophisticated matching)
      return dismissedIssues.some((dismissed) => {
        if (!dismissed.originalIssue) return false;
        const similarity = calculateSimilarity(issueDescription, dismissed.originalIssue);
        return similarity > 0.7; // 70% similarity threshold
      });
    };

    const calculateSimilarity = (text1, text2) => {
      if (!text1 || !text2) return 0;

      const words1 = text1.toLowerCase().split(/\s+/);
      const words2 = text2.toLowerCase().split(/\s+/);

      const commonWords = words1.filter((word) => words2.includes(word));
      const totalWords = new Set([...words1, ...words2]).size;

      return commonWords.length / totalWords;
    };

    const formatCodeInText = (text) => {
      if (!text) return text;

      // Convert single quotes around code-like elements to backticks
      // This regex matches single quotes around words that look like code (contain hyphens, underscores, or are common code terms)
      return text
        .replace(/'([a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9])'/g, '`$1`') // 'timeout-minutes' -> `timeout-minutes`
        .replace(/'([a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]*[a-zA-Z0-9])'/g, '`$1`') // 'snake_case' -> `snake_case`
        .replace(
          /'(if|else|function|class|const|let|var|return|import|export|async|await|try|catch|throw|for|while|do|switch|case|break|continue|typeof|instanceof|new|this|super|extends|implements|public|private|protected|static|abstract|interface|namespace|enum|type|declare|module|require|default)'/g,
          '`$1`'
        ) // JavaScript/TypeScript keywords
        .replace(
          /'(permissions|timeout-minutes|runs-on|uses|with|env|if|steps|name|run|shell|working-directory|continue-on-error)'/g,
          '`$1`'
        ); // GitHub Actions keywords
    };

    // Load existing feedback data
    const existingFeedback = await loadFeedbackData();
    const currentFeedback = {};

    // Check if review output exists
    if (!fs.existsSync(reviewOutputPath)) {
      console.log('❌ Review output file not found');
      return;
    }

    // Read and parse review results
    const reviewData = JSON.parse(fs.readFileSync(reviewOutputPath, 'utf8'));
    const uniqueCommentId = '<!-- ai-code-review-action -->';

    console.log('✅ JSON file is valid');

    const totalIssues = reviewData.summary?.totalIssues || 0;
    const filesWithIssues = reviewData.summary?.filesWithIssues || 0;

    console.log(`📊 Parsing results: ${totalIssues} issues, ${filesWithIssues} files`);

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

    // Analyze feedback from previous comments before cleanup
    if (postComments && trackFeedback) {
      console.log('📊 Analyzing feedback from previous AI comments...');

      const { data: reviewComments } = await github.rest.pulls.listReviewComments({
        pull_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
      });

      const botReviewComments = reviewComments.filter(
        (comment) => comment.body.includes(uniqueCommentId) && comment.user.login === 'github-actions[bot]'
      );

      // Analyze feedback for each existing comment
      for (const comment of botReviewComments) {
        const feedback = await analyzeFeedback(comment.id, comment.body);
        if (feedback) {
          // Store original issue description for similarity matching
          const issueMatch = comment.body.match(/\*\*(.*?)\*\*/);
          feedback.originalIssue = issueMatch ? issueMatch[1] : comment.body.substring(0, 100);
          currentFeedback[comment.id] = feedback;
          console.log(`📝 Collected feedback for comment ${comment.id}: ${feedback.overallSentiment}`);
        }
      }

      console.log(`📊 Collected feedback from ${Object.keys(currentFeedback).length} previous comments`);
    }

    // Delete previous line comments
    if (postComments) {
      console.log('🔄 Cleaning up previous line comments...');

      const { data: reviewComments } = await github.rest.pulls.listReviewComments({
        pull_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
      });

      const botReviewComments = reviewComments.filter(
        (comment) => comment.body.includes(uniqueCommentId) && comment.user.login === 'github-actions[bot]'
      );

      for (const comment of botReviewComments) {
        await github.rest.pulls.deleteReviewComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: comment.id,
        });
      }
    }

    // Post or update summary comment
    if (summaryComment) {
      const summaryBody = `## 🤖 CodeCritique Review Summary

**Files Analyzed:** ${reviewData.summary?.totalFilesReviewed || 'N/A'}
**Issues Found:** ${totalIssues}
**Analysis Time:** ${analysisTime}s

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
          if (shouldSkipSimilarIssue(issue.description, existingFeedback)) {
            console.log(`⏭️ Skipping similar issue based on previous feedback: ${issue.description.substring(0, 50)}...`);
            continue;
          }

          const lineNum = issue.lineNumbers?.[0] || 1;
          const severity = issue.severity || 'info';
          const emoji = severity === 'error' ? '🚨' : severity === 'warning' ? '⚠️' : severity === 'medium' ? '⚠️' : '💡';

          let commentBody = `${emoji} **CodeCritique Review**

${formatCodeInText(issue.description)}`;

          if (issue.suggestion) {
            commentBody += `

**Suggestion:**
${formatCodeInText(issue.suggestion)}`;
          }

          commentBody += `

*Severity: ${severity}*`;

          // Add feedback tracking notice if enabled
          if (trackFeedback) {
            commentBody += `

*💬 Your feedback helps improve future reviews. React with 👍/👎 or reply to let us know if this suggestion is helpful.*`;
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
      }
    }

    console.log('✅ Comment posting completed');
  } catch (error) {
    console.error('❌ Error in comment posting script:', error.message);
    core.setFailed(`Comment posting failed: ${error.message}`);
  }
};
