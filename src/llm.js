/**
 * LLM Integration Module
 *
 * This module provides functionality to interact with Large Language Models (LLMs)
 * for code analysis and review. Enhanced to leverage project-specific patterns and
 * feedback from PR reviews for more context-aware recommendations.
 * Currently supports Anthropic's Claude Sonnet 4.
 *
 * Prompt Caching:
 * This module uses Anthropic's prompt caching feature for cost optimization.
 * Static content in the system message is cached and reused across multiple
 * requests, reducing input token costs by 75%.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { Anthropic } from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { verboseLog } from './utils/logging.js';

// Load env variables if present; do not enforce key at import time
if (process.env.CODECRITIQUE_SKIP_DOTENV !== '1') {
  dotenv.config({ quiet: true });
}

let anthropic = null;

const FEDERATION_AUDIENCE = 'https://api.anthropic.com';

// A GitHub OIDC token can be exchanged only once, so every exchange requests a new one.
async function fetchGitHubActionsIdToken() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', FEDERATION_AUDIENCE);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`GitHub Actions OIDC token request failed with status ${response.status}`);
  }
  return (await response.json()).value;
}

function createFederatedClient() {
  const { ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_WORKSPACE_ID } = process.env;
  if (!ANTHROPIC_ORGANIZATION_ID || !ANTHROPIC_SERVICE_ACCOUNT_ID) {
    throw new Error('Workload Identity Federation requires ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_SERVICE_ACCOUNT_ID.');
  }
  // Null keeps a stray ANTHROPIC_AUTH_TOKEN in the environment from replacing the federated credentials.
  return new Anthropic({
    authToken: null,
    credentials: oidcFederationProvider({
      identityTokenProvider: fetchGitHubActionsIdToken,
      federationRuleId: ANTHROPIC_FEDERATION_RULE_ID,
      organizationId: ANTHROPIC_ORGANIZATION_ID,
      serviceAccountId: ANTHROPIC_SERVICE_ACCOUNT_ID,
      workspaceId: ANTHROPIC_WORKSPACE_ID || undefined,
      baseURL: process.env.ANTHROPIC_BASE_URL || FEDERATION_AUDIENCE,
      fetch,
    }),
  });
}

/**
 * Get the Anthropic client. Uses ANTHROPIC_API_KEY when set, else Workload
 * Identity Federation in GitHub Actions.
 * @returns {Anthropic} The Anthropic client
 */
function getAnthropicClient() {
  if (anthropic) {
    return anthropic;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    anthropic = new Anthropic({ apiKey });
  }
  else if (process.env.ANTHROPIC_FEDERATION_RULE_ID && process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    anthropic = createFederatedClient();
  }
  else {
    throw new Error(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY in env or .env, or configure Workload Identity Federation in GitHub Actions.'
    );
  }
  return anthropic;
}

// Default model
const DEFAULT_MODEL = 'claude-sonnet-5';

// Models after the 4.6 generation reject `temperature` with a 400. Only send it
// for the older families; unknown models fall back to the API default.
const SAMPLING_MODEL_PATTERN = /^claude-(?:3|(?:opus|sonnet|haiku)-4-[0-6])/;

// Maximum tokens for response
const MAX_TOKENS = 4096;

const DEFAULT_BATCH_POLL_INTERVAL_MS = 10000;
const MAX_BATCH_POLL_FAILURES = 3;

const MAX_CACHE_CONTROL_BLOCKS = 4;

function normalizeSystemBlock(block, cacheControl) {
  const normalizedBlock = typeof block === 'string' ? { type: 'text', text: block } : { type: 'text', ...block };

  if (cacheControl) {
    return {
      ...normalizedBlock,
      cache_control: normalizedBlock.cache_control || cacheControl,
    };
  }

  return normalizedBlock;
}

function buildSystemContent(system, cachedSystemBlocks, cacheControl) {
  if (!system && cachedSystemBlocks.length === 0) {
    return 'You are an expert code reviewer with deep knowledge of software engineering principles, design patterns, and best practices.';
  }

  const systemBlocks = [];
  const appendBlock = (block) => {
    const cacheable = systemBlocks.filter((existingBlock) => existingBlock.cache_control).length < MAX_CACHE_CONTROL_BLOCKS;
    systemBlocks.push(normalizeSystemBlock(block, cacheable ? cacheControl : null));
  };

  if (Array.isArray(system)) {
    system.forEach(appendBlock);
  }
  else if (system) {
    appendBlock(system);
  }

  cachedSystemBlocks.filter(Boolean).forEach(appendBlock);

  return systemBlocks;
}

async function createBatchedMessage(client, requestParams, options) {
  const customId = 'codecritique-review';
  let batch = await client.messages.batches.create({
    requests: [{ custom_id: customId, params: requestParams }],
  });

  verboseLog(options, chalk.cyan(`Submitted Claude message batch ${batch.id}; waiting for completion...`));
  let consecutivePollFailures = 0;

  while (batch.processing_status !== 'ended') {
    await delay(DEFAULT_BATCH_POLL_INTERVAL_MS);
    try {
      batch = await client.messages.batches.retrieve(batch.id);
      consecutivePollFailures = 0;
    }
    catch (error) {
      consecutivePollFailures++;
      if (consecutivePollFailures >= MAX_BATCH_POLL_FAILURES) {
        throw new Error(`Unable to poll Claude message batch ${batch.id} after ${MAX_BATCH_POLL_FAILURES} attempts: ${error.message}`);
      }
      console.warn(chalk.yellow(`Unable to poll Claude message batch ${batch.id}; retrying: ${error.message}`));
    }
  }

  const results = await client.messages.batches.results(batch.id);
  for await (const response of results) {
    if (response.custom_id !== customId) {
      continue;
    }

    if (response.result.type === 'succeeded') {
      return response.result.message;
    }

    const detail = response.result.type === 'errored' ? `: ${response.result.error.error.message}` : '';
    throw new Error(`Claude batch request ${response.result.type}${detail}`);
  }

  throw new Error('Claude batch response did not contain the review request');
}

/**
 * Send a prompt to Claude and get a structured JSON response using tool calling.
 * Uses prompt caching for system prompts to reduce token costs.
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {Object} options - Options for the request
 * @param {string} options.system - System prompt (will be cached for cost optimization)
 * @param {Array<string|Object>} options.cachedSystemBlocks - Additional stable system blocks to cache when possible
 * @param {Object} options.jsonSchema - JSON schema for structured output
 * @param {boolean} [options.strict=false] - Enforce the schema on the tool input. Every object in the
 *   schema must set `additionalProperties: false`, and `additionalProperties` accepts no other value.
 * @param {string} options.cacheTtl - Cache TTL: '5m' (default, no extra cost) or '1h' (extended, extra cost for writes)
 * @param {boolean} [options.batch=false] - Use the asynchronous Message Batches API
 * @returns {Promise<Object>} The response from Claude with structured data
 */
async function sendPromptToClaude(prompt, options = {}) {
  const {
    model = DEFAULT_MODEL,
    maxTokens = MAX_TOKENS,
    temperature = 0.7,
    system = '',
    cachedSystemBlocks = [],
    jsonSchema = null,
    strict = false,
    cacheTtl = '5m',
  } = options;

  try {
    verboseLog(options, chalk.cyan('Sending prompt to Claude...'));

    const client = getAnthropicClient();

    // Build system content with cache_control for cost optimization
    // The system is passed as an array of blocks with cache_control on the static portion
    // TTL options: '5m' (default, no extra cost) or '1h' (extended, extra cost for cache writes)
    const cacheControl = cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

    const systemContent = buildSystemContent(system, cachedSystemBlocks, cacheControl);

    // Build base request parameters
    const requestParams = {
      model,
      max_tokens: maxTokens,
      ...(SAMPLING_MODEL_PATTERN.test(model) ? { temperature } : {}),
      system: systemContent,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    // Add tool calling if JSON schema is provided
    if (jsonSchema) {
      requestParams.tools = [
        {
          name: 'return_json',
          description: 'Return the final answer strictly as JSON matching the schema.',
          input_schema: jsonSchema,
          // Omitted rather than sent as false so the tool block stays byte-identical
          // for callers that do not use it, which keeps their cached prefix valid.
          ...(strict ? { strict: true } : {}),
        },
      ];
      requestParams.tool_choice = { type: 'tool', name: 'return_json' };
    }

    const response = options.batch
      ? await createBatchedMessage(client, requestParams, options)
      : await client.messages.create(requestParams);

    // Log response structure for debugging
    verboseLog(options, chalk.gray(`  Response stop_reason: ${response.stop_reason}`));
    verboseLog(options, chalk.gray(`  Response content blocks: ${response.content?.length || 0}`));

    // A refusal arrives as HTTP 200 with no tool_use and no text, so it must be caught
    // here or it surfaces as a missing-output error that hides the real cause.
    if (response.stop_reason === 'refusal') {
      const { category, explanation } = response.stop_details || {};
      const reason = explanation || 'no explanation provided';
      throw new Error(`Claude declined the request${category ? ` (${category})` : ''}: ${reason}`);
    }

    // Truncation also arrives as HTTP 200. Without this the tool path reports missing
    // output and the text path returns a severed answer that reads as a complete one.
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
      const remedy =
        response.stop_reason === 'max_tokens' ? 'Increase the configured output limit or continue the response.' : 'Reduce the input size.';
      throw new Error(`Claude's response was truncated (${response.stop_reason}). ${remedy}`);
    }

    // Process response based on whether we used tool calling
    if (jsonSchema) {
      const toolUse = response.content.find((block) => block.type === 'tool_use' && block.name === 'return_json');

      if (!toolUse) {
        // Log actual content for debugging
        console.error(chalk.red('No tool_use block found. Response content:'));
        response.content?.forEach((block, i) => {
          console.error(chalk.gray(`  Block ${i}: type=${block.type}, name=${block.name || 'N/A'}`));
        });
        throw new Error('No structured output received from Claude');
      }

      return {
        content: JSON.stringify(toolUse.input, null, 2),
        model: response.model,
        usage: response.usage,
        json: toolUse.input,
      };
    }
    else {
      return {
        content: response.content?.find((block) => block.type === 'text')?.text || '',
        model: response.model,
        usage: response.usage,
      };
    }
  }
  catch (error) {
    console.error(chalk.red(`Error sending prompt to Claude: ${error.message}`));
    throw error;
  }
}

export { sendPromptToClaude };
