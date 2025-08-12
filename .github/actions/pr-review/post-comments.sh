#!/bin/bash

# GitHub PR Comment Posting Script
# Processes AI code review output and posts comments to PR

set -e

REVIEW_OUTPUT_FILE="review_output.json"
MAX_COMMENTS=${INPUT_MAX_COMMENTS:-25}
POST_COMMENTS=${INPUT_POST_COMMENTS:-true}
SUMMARY_COMMENT=${INPUT_SUMMARY_COMMENT:-true}

# Check if we should post comments
if [ "$POST_COMMENTS" != "true" ]; then
    echo "⏭️  Comment posting disabled, skipping..."
    exit 0
fi

# Check if we're in a PR context
if [ -z "$GITHUB_EVENT_PATH" ] || [ ! -f "$GITHUB_EVENT_PATH" ]; then
    echo "⚠️  Not in a PR context, skipping comment posting"
    exit 0
fi

# Extract PR information
PR_NUMBER=$(jq -r '.pull_request.number // empty' "$GITHUB_EVENT_PATH")
if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
    echo "⚠️  No PR number found, skipping comment posting"
    exit 0
fi

echo "💬 Processing review results for PR #$PR_NUMBER"

# Check if review output exists
if [ ! -f "$REVIEW_OUTPUT_FILE" ]; then
    echo "❌ Review output file not found: $REVIEW_OUTPUT_FILE"
    exit 1
fi

# Parse review results
if [ "$INPUT_OUTPUT_FORMAT" = "json" ]; then
    # Debug: Show first few lines of JSON for debugging
    echo "📋 Review output sample:"
    head -10 "$REVIEW_OUTPUT_FILE"

    # Handle both array format and object format with details/summary
    if jq -e '.summary' "$REVIEW_OUTPUT_FILE" >/dev/null 2>&1; then
        # New format with summary and details
        TOTAL_ISSUES=$(jq '.summary.totalIssues // 0' "$REVIEW_OUTPUT_FILE" 2>/dev/null || echo "0")
        FILES_WITH_ISSUES=$(jq '.summary.filesWithIssues // 0' "$REVIEW_OUTPUT_FILE" 2>/dev/null || echo "0")
        echo "📊 Parsed from summary: $TOTAL_ISSUES issues, $FILES_WITH_ISSUES files"
    else
        # Legacy array format
        TOTAL_ISSUES=$(jq '[.[].issues // [] | length] | add // 0' "$REVIEW_OUTPUT_FILE" 2>/dev/null || echo "0")
        FILES_WITH_ISSUES=$(jq '[.[] | select(.issues and (.issues | length > 0))] | length' "$REVIEW_OUTPUT_FILE" 2>/dev/null || echo "0")
        echo "📊 Parsed from legacy format: $TOTAL_ISSUES issues, $FILES_WITH_ISSUES files"
    fi
else
    TOTAL_ISSUES="0"
    FILES_WITH_ISSUES="1"
fi

echo "📊 Found $TOTAL_ISSUES issues across $FILES_WITH_ISSUES files"

# Post summary comment if enabled
if [ "$SUMMARY_COMMENT" = "true" ]; then
    echo "📋 Posting summary comment..."

    SUMMARY_BODY="## 🤖 AI Code Review Summary

**Files Analyzed:** $(jq '. | length' "$REVIEW_OUTPUT_FILE" 2>/dev/null || echo "N/A")
**Issues Found:** $TOTAL_ISSUES
**Analysis Time:** ${ANALYSIS_TIME:-N/A}s

"

    if [ "$TOTAL_ISSUES" -gt 0 ]; then
        SUMMARY_BODY="${SUMMARY_BODY}### 📋 Review Results

The AI has identified potential improvements in your code. Please review the inline comments for detailed feedback.

"
    else
        SUMMARY_BODY="${SUMMARY_BODY}### ✅ No Issues Found

Great job! The AI review didn't identify any significant issues with your changes.

"
    fi

    # Add embedding context info if available
    if [ -d ".ai-embeddings" ]; then
        SUMMARY_BODY="${SUMMARY_BODY}*Review was enhanced with codebase context using cached embeddings.*"
    else
        SUMMARY_BODY="${SUMMARY_BODY}*Review was performed without codebase context. Consider generating embeddings for more contextual analysis.*"
    fi

    # Check for existing AI review summary comment and update it
    EXISTING_COMMENT_ID=$(gh api repos/:owner/:repo/issues/$PR_NUMBER/comments --jq '.[] | select(.body | contains("## 🤖 AI Code Review Summary")) | .id' | head -1)

    if [ -n "$EXISTING_COMMENT_ID" ]; then
        echo "🔄 Updating existing summary comment ID: $EXISTING_COMMENT_ID"
        gh api repos/:owner/:repo/issues/comments/$EXISTING_COMMENT_ID \
            --method PATCH \
            --field body="$SUMMARY_BODY" \
            --silent || echo "⚠️  Failed to update summary comment"
    else
        echo "➕ Creating new summary comment"
        gh api repos/:owner/:repo/issues/$PR_NUMBER/comments \
            --method POST \
            --field body="$SUMMARY_BODY" \
            --silent || echo "⚠️  Failed to post summary comment"
    fi
fi

# Post inline comments for specific issues
if [ "$INPUT_OUTPUT_FORMAT" = "json" ] && [ "$TOTAL_ISSUES" -gt 0 ]; then
    echo "💬 Processing inline comments..."

    COMMENTS_POSTED=0

    # Handle different JSON formats
    if jq -e '.details' "$REVIEW_OUTPUT_FILE" >/dev/null 2>&1; then
        # New format with details array
        FILES_DATA=$(jq -c '.details[]' "$REVIEW_OUTPUT_FILE")
    else
        # Legacy array format
        FILES_DATA=$(jq -c '.[]' "$REVIEW_OUTPUT_FILE")
    fi

    # Process each file's issues
    echo "$FILES_DATA" | while IFS= read -r file_result; do
        if [ "$COMMENTS_POSTED" -ge "$MAX_COMMENTS" ]; then
            echo "📊 Reached maximum comment limit ($MAX_COMMENTS)"
            break
        fi

        FILE_PATH=$(echo "$file_result" | jq -r '.filePath // .file // .path // empty')
        ISSUES=$(echo "$file_result" | jq -c '.review.issues // .issues // []')

        if [ -z "$FILE_PATH" ] || [ "$FILE_PATH" = "null" ]; then
            continue
        fi

        # Process each issue in the file
        echo "$ISSUES" | jq -c '.[]?' | while IFS= read -r issue; do
            if [ "$COMMENTS_POSTED" -ge "$MAX_COMMENTS" ]; then
                break
            fi

            DESCRIPTION=$(echo "$issue" | jq -r '.description // .message // "Code review suggestion"')
            SEVERITY=$(echo "$issue" | jq -r '.severity // "info"')
            LINE_NUM=$(echo "$issue" | jq -r '.lineNumbers[0] // .line // 1')
            SUGGESTION=$(echo "$issue" | jq -r '.suggestion // empty')

            # Format the comment
            case "$SEVERITY" in
                "error") EMOJI="🚨" ;;
                "warning") EMOJI="⚠️" ;;
                "info") EMOJI="ℹ️" ;;
                *) EMOJI="💡" ;;
            esac

            COMMENT_BODY="${EMOJI} **AI Code Review**

$DESCRIPTION"

            if [ -n "$SUGGESTION" ] && [ "$SUGGESTION" != "null" ]; then
                COMMENT_BODY="$COMMENT_BODY

**Suggestion:**
$SUGGESTION"
            fi

            COMMENT_BODY="$COMMENT_BODY

*Severity: $SEVERITY*"

            # Post the inline comment
            echo "📍 Posting comment for $FILE_PATH:$LINE_NUM"

            gh api repos/:owner/:repo/pulls/$PR_NUMBER/comments \
                --method POST \
                --field body="$COMMENT_BODY" \
                --field path="$FILE_PATH" \
                --field line="$LINE_NUM" \
                --field side="RIGHT" \
                --silent && {
                    COMMENTS_POSTED=$((COMMENTS_POSTED + 1))
                    echo "✅ Posted comment for $FILE_PATH"
                } || {
                    echo "⚠️  Failed to post comment for $FILE_PATH:$LINE_NUM"
                    # Try posting as a general PR comment instead
                    FALLBACK_BODY="**File: \`$FILE_PATH\` (Line $LINE_NUM)**

$COMMENT_BODY"

                    gh api repos/:owner/:repo/issues/$PR_NUMBER/comments \
                        --method POST \
                        --field body="$FALLBACK_BODY" \
                        --silent && {
                            COMMENTS_POSTED=$((COMMENTS_POSTED + 1))
                            echo "✅ Posted fallback comment for $FILE_PATH"
                        } || {
                            echo "❌ Failed to post fallback comment for $FILE_PATH"
                        }
                }
        done
    done

    echo "📊 Posted $COMMENTS_POSTED inline comments"
    echo "comments-posted=$COMMENTS_POSTED" >> $GITHUB_OUTPUT
else
    echo "⏭️  No inline comments to post"
    echo "comments-posted=0" >> $GITHUB_OUTPUT
fi

echo "✅ Comment posting completed"
