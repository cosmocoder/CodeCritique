import { parseDiffLineInfo } from './diff-lines.js';
import { addLineNumbers } from './string-utils.js';

// Conservative midpoint for source code; the prompt-size safety buffer covers tokenizer variance.
export const CHARS_PER_ESTIMATED_TOKEN = 3.5;
const DEFAULT_CONTEXT_LINE_RADIUS = 40;
const DEFAULT_MAX_FULL_CONTENT_TOKENS_PER_FILE = 12000;
export const DEFAULT_MAX_TOTAL_FULL_CONTENT_TOKENS = 60000;
const DEFAULT_MAX_SINGLE_FILE_BUDGET_SHARE = 0.5;

/**
 * @typedef {object} HolisticFileContextPlan
 * @property {number} index - Original PR file index.
 * @property {string} path - Display path for observability.
 * @property {'full' | 'focused'} mode - Context rendering mode.
 * @property {string} reason - Human-readable rendering reason for the prompt.
 * @property {number} fullContentTokens - Estimated token cost of complete file content.
 * @property {number} diffTokens - Estimated token cost of the diff paired with this plan.
 * @property {number} contextTokens - Estimated token cost of rendered file context only.
 * @property {number} totalTokens - Estimated token cost of diff plus rendered file context.
 * @property {number} contextLineRadius - Focused-context line radius selected by planning.
 * @property {number | undefined} maxFocusedContextTokens - Focused-context token ceiling selected by chunking.
 */

export function estimatePrContextTokens(text) {
  return Math.ceil((text?.length || 0) / CHARS_PER_ESTIMATED_TOKEN);
}

function getFilePath(file, index) {
  return file.filePath || file.path || `file-${index + 1}`;
}

function getFileContent(file) {
  return file.fullContent ?? file.content ?? '';
}

function getChangedLineAnchors(file) {
  const diffInfoLineNumbers = (file.diffInfo?.addedLines || [])
    .map((line) => line?.lineNumber)
    .filter((lineNumber) => Number.isInteger(lineNumber) && lineNumber > 0);
  const parsedLineNumbers = parseDiffLineInfo(file.diff || file.diffContent, {
    includeRemovalAnchors: true,
    includeHunkStartFallback: true,
  }).changedLineNumbers;

  return [...diffInfoLineNumbers, ...parsedLineNumbers];
}

function normalizeLineNumbers(lineNumbers, totalLines) {
  if (totalLines <= 0) {
    return [];
  }

  return [...new Set(lineNumbers.map((lineNumber) => Math.min(Math.max(lineNumber, 1), totalLines)))].sort((a, b) => a - b);
}

function mergeLineWindows(normalizedLines, totalLines, radius) {
  const windows = [];

  for (const lineNumber of normalizedLines) {
    const nextWindow = {
      start: Math.max(1, lineNumber - radius),
      end: Math.min(totalLines, lineNumber + radius),
    };

    if (nextWindow.start > nextWindow.end) {
      continue;
    }

    const previousWindow = windows.at(-1);

    if (previousWindow && nextWindow.start <= previousWindow.end + 1) {
      previousWindow.end = Math.max(previousWindow.end, nextWindow.end);
    }
    else {
      windows.push(nextWindow);
    }
  }

  return windows;
}

function addLineNumbersForRange(lines, startLine) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width)} | ${line}`).join('\n');
}

function renderFocusedContext(file, plan, lines, windows) {
  const renderedWindows = windows
    .map((window, index) => {
      const windowLines = lines.slice(window.start - 1, window.end);
      return `#### Context Window ${index + 1}: lines ${window.start}-${window.end}
\`\`\`${file.language || ''}
${addLineNumbersForRange(windowLines, window.start)}
\`\`\``;
    })
    .join('\n\n');

  const includedLineCount = windows.reduce((sum, window) => sum + (window.end - window.start + 1), 0);
  const omittedLineCount = Math.max(0, lines.length - includedLineCount);
  const windowSection =
    renderedWindows || '_No focused file context windows fit within the chunk token budget; use the diff above for the exact change._';

  return `### Focused File Context
Full file content omitted to control prompt size. Included ${includedLineCount} of ${lines.length} lines around changed hunks; omitted ${omittedLineCount} unchanged lines.
Reason: ${plan.reason}.

${windowSection}`;
}

function estimateLineRangeTokens(lines, startLine, endLine) {
  return estimatePrContextTokens(addLineNumbersForRange(lines.slice(startLine - 1, endLine), startLine));
}

function estimateFocusedWindowTokens(file, lines, window) {
  const windowShell = `#### Context Window 1: lines ${window.start}-${window.end}
\`\`\`${file.language || ''}

\`\`\``;
  return estimatePrContextTokens(windowShell) + estimateLineRangeTokens(lines, window.start, window.end);
}

function estimateFocusedContextTokens(file, plan, lines, windows) {
  const includedLineCount = windows.reduce((sum, window) => sum + (window.end - window.start + 1), 0);
  const omittedLineCount = Math.max(0, lines.length - includedLineCount);
  const preambleTokens = estimatePrContextTokens(`### Focused File Context
Full file content omitted to control prompt size. Included ${includedLineCount} of ${lines.length} lines around changed hunks; omitted ${omittedLineCount} unchanged lines.
Reason: ${plan.reason}.

`);

  if (windows.length === 0) {
    return (
      preambleTokens +
      estimatePrContextTokens(
        '_No focused file context windows fit within the chunk token budget; use the diff above for the exact change._'
      )
    );
  }

  return windows.reduce((sum, window) => sum + estimateFocusedWindowTokens(file, lines, window), preambleTokens);
}

function selectMinimalWindowsUntilBudget(file, plan, lines, lineNumbers, maxContextTokens) {
  const windows = [];
  let estimatedTokens = estimateFocusedContextTokens(file, plan, lines, []);

  for (const lineNumber of lineNumbers) {
    const candidateWindow = { start: lineNumber, end: lineNumber };
    const candidateTokens = estimatedTokens + estimateFocusedWindowTokens(file, lines, candidateWindow);
    if (candidateTokens > maxContextTokens) {
      break;
    }

    windows.push(candidateWindow);
    estimatedTokens = candidateTokens;
  }

  return windows;
}

function enforceRenderedContextBudget(file, plan, lines, windows, maxContextTokens) {
  if (!Number.isFinite(maxContextTokens)) {
    return windows;
  }

  let fittedWindows = [...windows];
  while (fittedWindows.length > 0 && estimatePrContextTokens(renderFocusedContext(file, plan, lines, fittedWindows)) > maxContextTokens) {
    fittedWindows = fittedWindows.slice(0, -1);
  }

  return fittedWindows;
}

/**
 * Fit focused context windows within a token budget, shrinking radius before dropping anchors.
 *
 * @param {object} file - PR file metadata.
 * @param {object} plan - Focused-context plan.
 * @param {string[]} lines - Current file content split by line.
 * @param {number[]} lineNumbers - Candidate changed-line anchors.
 * @param {number} radius - Preferred context radius.
 * @param {number | undefined} maxContextTokens - Optional token ceiling for focused context.
 * @returns {Array<{start: number, end: number}>} Windows to render.
 */
function fitWindowsToTokenBudget(file, plan, lines, lineNumbers, radius, maxContextTokens) {
  const normalizedLines = normalizeLineNumbers(lineNumbers, lines.length);

  if (!Number.isFinite(maxContextTokens)) {
    return mergeLineWindows(normalizedLines, lines.length, radius);
  }

  if (maxContextTokens <= 0 || normalizedLines.length === 0) {
    return [];
  }

  const fullRadiusWindows = mergeLineWindows(normalizedLines, lines.length, radius);
  if (estimateFocusedContextTokens(file, plan, lines, fullRadiusWindows) <= maxContextTokens) {
    return enforceRenderedContextBudget(file, plan, lines, fullRadiusWindows, maxContextTokens);
  }

  const minimalWindows = mergeLineWindows(normalizedLines, lines.length, 0);
  if (estimateFocusedContextTokens(file, plan, lines, minimalWindows) > maxContextTokens) {
    return enforceRenderedContextBudget(
      file,
      plan,
      lines,
      selectMinimalWindowsUntilBudget(file, plan, lines, normalizedLines, maxContextTokens),
      maxContextTokens
    );
  }

  let bestWindows = minimalWindows;
  let low = 0;
  let high = radius;

  while (low <= high) {
    const candidateRadius = Math.floor((low + high) / 2);
    const candidateWindows = mergeLineWindows(normalizedLines, lines.length, candidateRadius);
    const candidateTokens = estimateFocusedContextTokens(file, plan, lines, candidateWindows);

    if (candidateTokens <= maxContextTokens) {
      bestWindows = candidateWindows;
      low = candidateRadius + 1;
    }
    else {
      high = candidateRadius - 1;
    }
  }

  return enforceRenderedContextBudget(file, plan, lines, bestWindows, maxContextTokens);
}

export function buildFocusedFileContext(file, plan, options = {}) {
  const radius = options.contextLineRadius ?? plan.contextLineRadius ?? DEFAULT_CONTEXT_LINE_RADIUS;
  const maxContextTokens = options.maxFocusedContextTokens ?? plan.maxFocusedContextTokens;
  const content = getFileContent(file);
  const lines = content.split('\n');
  let changedLines = getChangedLineAnchors(file);

  if (changedLines.length === 0) {
    changedLines = [1];
  }

  const windows = fitWindowsToTokenBudget(file, plan, lines, changedLines, radius, maxContextTokens);

  return renderFocusedContext(file, plan, lines, windows);
}

export function buildFullFileContext(file) {
  const content = getFileContent(file);
  return `### Full File Content (For Context - line numbers shown for reference):
\`\`\`${file.language || ''}
${addLineNumbers(content)}
\`\`\``;
}

export function formatPlannedHolisticFileContext(file, plan, options = {}) {
  if (plan.mode === 'full') {
    return buildFullFileContext(file);
  }

  return buildFocusedFileContext(file, plan, options);
}

function setPlanCosts(plan, contextTokens) {
  return {
    ...plan,
    contextTokens,
    totalTokens: plan.diffTokens + contextTokens,
  };
}

function assignPlanCosts(plan, contextTokens) {
  plan.contextTokens = contextTokens;
  plan.totalTokens = plan.diffTokens + contextTokens;
}

function estimatePlanContextTokens(file, plan, options = {}) {
  if (plan.mode === 'full') {
    return plan.fullContentTokens;
  }

  return estimatePrContextTokens(buildFocusedFileContext(file, plan, options));
}

function createInitialPlan(file, index, contextLineRadius) {
  const fullContentTokens = estimatePrContextTokens(getFileContent(file));
  const diffTokens = estimatePrContextTokens(file.diff || file.diffContent);
  return {
    index,
    path: getFilePath(file, index),
    mode: 'focused',
    reason: '',
    fullContentTokens,
    diffTokens,
    contextTokens: 0,
    totalTokens: diffTokens,
    contextLineRadius,
  };
}

function planHolisticFileContexts(prFiles, options = {}) {
  const maxTotalTokens = options.maxTotalFullContentTokens ?? DEFAULT_MAX_TOTAL_FULL_CONTENT_TOKENS;
  const defaultSingleFileTokens = Math.max(
    DEFAULT_MAX_FULL_CONTENT_TOKENS_PER_FILE,
    Math.floor(maxTotalTokens * DEFAULT_MAX_SINGLE_FILE_BUDGET_SHARE)
  );
  const maxSingleFileTokens = options.maxSingleFullContentTokens ?? defaultSingleFileTokens;
  const plans = prFiles.map((file, index) => createInitialPlan(file, index, DEFAULT_CONTEXT_LINE_RADIUS));

  const eligiblePlans = plans
    .filter((plan) => plan.fullContentTokens <= maxSingleFileTokens)
    .sort((a, b) => {
      // Diff-heavy files are more likely to need broad context; cap size influence so one giant file cannot dominate.
      const scoreA = Math.min(a.fullContentTokens, DEFAULT_MAX_FULL_CONTENT_TOKENS_PER_FILE) + a.diffTokens * 2;
      const scoreB = Math.min(b.fullContentTokens, DEFAULT_MAX_FULL_CONTENT_TOKENS_PER_FILE) + b.diffTokens * 2;
      return scoreB - scoreA;
    });
  let remainingBudget = maxTotalTokens;

  for (const plan of eligiblePlans) {
    if (plan.fullContentTokens > remainingBudget) {
      continue;
    }

    plan.mode = 'full';
    plan.reason = 'full content fits holistic context budget';
    assignPlanCosts(plan, plan.fullContentTokens);
    remainingBudget -= plan.fullContentTokens;
  }

  for (const plan of plans) {
    if (plan.mode === 'focused') {
      if (plan.fullContentTokens > maxSingleFileTokens) {
        plan.reason = `full content estimate ${plan.fullContentTokens} tokens exceeds per-file holistic context ceiling ${maxSingleFileTokens}`;
      }
      else {
        plan.reason = `full content estimate ${plan.fullContentTokens} tokens was not selected within total holistic context budget ${maxTotalTokens}`;
      }
      const file = prFiles[plan.index];
      assignPlanCosts(plan, estimatePlanContextTokens(file, plan, options));
    }
  }

  return plans;
}

function getFullContentAllocation(plans) {
  return plans.reduce((sum, plan) => {
    if (plan?.mode !== 'full') {
      return sum;
    }

    return sum + (plan.contextTokens || 0);
  }, 0);
}

export function fileCost(plan) {
  return plan?.totalTokens || 0;
}

export function diffCost(fileOrPlan) {
  if (Number.isFinite(fileOrPlan?.diffTokens)) {
    return fileOrPlan.diffTokens;
  }

  return estimatePrContextTokens(fileOrPlan?.diff || fileOrPlan?.diffContent);
}

export function rawFullContentCost(file) {
  return estimatePrContextTokens(getFileContent(file));
}

export function planContextCost(plan) {
  return plan?.contextTokens || 0;
}

export function fitHolisticPlanToChunk(file, plan, maxTotalTokens) {
  const diffTokens = diffCost(file);

  if (plan.mode !== 'focused') {
    return setPlanCosts({ ...plan, diffTokens }, plan.contextTokens);
  }

  const contextBudget = Math.max(maxTotalTokens - diffTokens, 0);
  const adjustedPlan = {
    ...plan,
    diffTokens,
    maxFocusedContextTokens: contextBudget,
    reason: contextBudget < plan.contextTokens ? `${plan.reason}; focused context reduced to fit chunk token budget` : plan.reason,
  };
  return setPlanCosts(adjustedPlan, estimatePlanContextTokens(file, adjustedPlan));
}

/**
 * Merge existing holistic context plans with generated plans for files that are missing one.
 *
 * Existing full-content plans are counted against maxTotalFullContentTokens before
 * planning missing files, so partial callers keep the same total full-content budget invariant.
 *
 * @param {Array<object>} prFiles - PR file metadata objects.
 * @param {object} options - Context planning options.
 * @param {number} [options.maxTotalFullContentTokens] - Total token budget for full-file context across all files.
 * @param {number} [options.maxSingleFullContentTokens] - Hard per-file full-content eligibility ceiling.
 * @param {Array<object>} existingPlans - Existing plans by PR file index.
 * @returns {HolisticFileContextPlan[]} A plan for each PR file.
 */
export function mergeHolisticFileContextPlans(prFiles, options = {}, existingPlans = []) {
  const plans = Array.isArray(existingPlans) ? [...existingPlans] : [];
  const missingPlanIndexes = [];

  prFiles.forEach((file, index) => {
    if (file.holisticContextPlan) {
      plans[index] = file.holisticContextPlan;
    }

    if (!plans[index]) {
      missingPlanIndexes.push(index);
    }
  });

  if (missingPlanIndexes.length === 0) {
    return plans;
  }

  const maxTotalTokens = options.maxTotalFullContentTokens ?? DEFAULT_MAX_TOTAL_FULL_CONTENT_TOKENS;
  const remainingFullContentBudget = Math.max(0, maxTotalTokens - getFullContentAllocation(plans));
  const generatedPlans = planHolisticFileContexts(
    missingPlanIndexes.map((index) => prFiles[index]),
    { ...options, maxTotalFullContentTokens: remainingFullContentBudget }
  );

  missingPlanIndexes.forEach((index, generatedPlanIndex) => {
    plans[index] = generatedPlans[generatedPlanIndex];
  });

  return plans;
}
