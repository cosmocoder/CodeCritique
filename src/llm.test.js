import { sendPromptToClaude } from './llm.js';

// Create hoisted mock for the Anthropic SDK
const mockMessagesCreate = vi.hoisted(() => vi.fn());
const mockBatchesCreate = vi.hoisted(() => vi.fn());
const mockBatchesRetrieve = vi.hoisted(() => vi.fn());
const mockBatchesResults = vi.hoisted(() => vi.fn());
const mockAnthropicConstructor = vi.hoisted(() => vi.fn());

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: class MockAnthropic {
    constructor(options) {
      mockAnthropicConstructor(options);
    }

    messages = {
      create: mockMessagesCreate,
      batches: {
        create: mockBatchesCreate,
        retrieve: mockBatchesRetrieve,
        results: mockBatchesResults,
      },
    };
  },
}));

function batchResults(...responses) {
  return (async function* iterateResults() {
    yield* responses;
  })();
}

describe('sendPromptToClaude', () => {
  beforeEach(() => {
    mockConsoleSelective('log', 'error');

    // Set up mock API key
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  describe('basic text response', () => {
    it('should send prompt and return text response', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'This is the response' }],
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = await sendPromptToClaude('Review this code');

      expect(result.content).toBe('This is the response');
      expect(result.model).toBe('claude-sonnet-4-5');
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    it('should use default model and settings', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await sendPromptToClaude('Test prompt');

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-5',
          max_tokens: 4096,
        })
      );
    });

    it('should surface the refusal explanation instead of a missing-output error', async () => {
      mockMessagesCreate.mockResolvedValue({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined: offensive tooling.' },
        content: [],
        model: 'claude-sonnet-5',
        usage: {},
      });

      await expect(sendPromptToClaude('Test prompt', { jsonSchema: { type: 'object' } })).rejects.toThrow(
        'Claude declined the request (cyber): Declined: offensive tooling.'
      );
    });

    it.each([
      ['max_tokens', 'Increase the configured output limit or continue the response.'],
      ['model_context_window_exceeded', 'Reduce the input size.'],
    ])('should report a truncated response for stop_reason %s', async (stopReason, remedy) => {
      mockMessagesCreate.mockResolvedValue({
        stop_reason: stopReason,
        content: [],
        model: 'claude-sonnet-5',
        usage: {},
      });

      await expect(sendPromptToClaude('Test prompt', { jsonSchema: { type: 'object' } })).rejects.toThrow(
        `Claude's response was truncated (${stopReason}). ${remedy}`
      );
    });

    it('should report truncation rather than returning a severed plain-text answer', async () => {
      mockMessagesCreate.mockResolvedValue({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'partial answer cut off mid-' }],
        model: 'claude-sonnet-5',
        usage: {},
      });

      await expect(sendPromptToClaude('Test prompt')).rejects.toThrow('was truncated (max_tokens)');
    });

    it('should read the text block even when a thinking block precedes it', async () => {
      mockMessagesCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'The real answer' },
        ],
        model: 'claude-sonnet-5',
        usage: {},
      });

      const result = await sendPromptToClaude('Test prompt');

      expect(result.content).toBe('The real answer');
    });

    it('should omit temperature for models that reject sampling parameters', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-5',
        usage: {},
      });

      await sendPromptToClaude('Test prompt', { temperature: 0.5 });

      expect(mockMessagesCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    });

    it('should set strict on the return_json tool when requested', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'return_json', input: { ok: true } }],
        model: 'claude-sonnet-5',
        usage: {},
      });

      await sendPromptToClaude('Test prompt', {
        jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        strict: true,
      });

      expect(mockMessagesCreate.mock.calls[0][0].tools[0]).toHaveProperty('strict', true);
    });

    it('should omit strict from the return_json tool by default', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'return_json', input: { ok: true } }],
        model: 'claude-sonnet-5',
        usage: {},
      });

      await sendPromptToClaude('Test prompt', {
        jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      });

      expect(mockMessagesCreate.mock.calls[0][0].tools[0]).not.toHaveProperty('strict');
    });

    it('should keep temperature for models that still accept it', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-haiku-4-5',
        usage: {},
      });

      await sendPromptToClaude('Test prompt', { model: 'claude-haiku-4-5', temperature: 0.1 });

      expect(mockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.1 }));
    });

    it('should use custom options', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-3-opus',
        usage: {},
      });

      await sendPromptToClaude('Test prompt', {
        model: 'claude-3-opus',
        maxTokens: 8192,
        temperature: 0.5,
        system: 'Custom system prompt',
      });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-3-opus',
          max_tokens: 8192,
          temperature: 0.5,
          system: [
            {
              type: 'text',
              text: 'Custom system prompt',
              cache_control: { type: 'ephemeral' },
            },
          ],
        })
      );
    });

    it('should retry polling and unwrap a successful batch request', async () => {
      const message = {
        content: [{ type: 'text', text: 'Batched response' }],
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      mockBatchesCreate.mockResolvedValue({ id: 'msgbatch_123', processing_status: 'in_progress' });
      mockBatchesRetrieve
        .mockRejectedValueOnce(new Error('Temporary network error'))
        .mockRejectedValueOnce(new Error('Temporary network error'))
        .mockResolvedValueOnce({ id: 'msgbatch_123', processing_status: 'in_progress' })
        .mockRejectedValueOnce(new Error('Temporary network error'))
        .mockRejectedValueOnce(new Error('Temporary network error'))
        .mockResolvedValueOnce({ id: 'msgbatch_123', processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(batchResults({ custom_id: 'codecritique-review', result: { type: 'succeeded', message } }));

      const result = await sendPromptToClaude('Review this code', { batch: true });

      expect(result.content).toBe('Batched response');
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(mockBatchesCreate).toHaveBeenCalledWith({
        requests: [
          {
            custom_id: 'codecritique-review',
            params: expect.objectContaining({
              model: 'claude-sonnet-5',
              messages: [{ role: 'user', content: 'Review this code' }],
            }),
          },
        ],
      });
      expect(mockBatchesRetrieve).toHaveBeenCalledTimes(6);
      expect(mockBatchesRetrieve).toHaveBeenCalledWith('msgbatch_123');
      expect(mockBatchesResults).toHaveBeenCalledWith('msgbatch_123');
    });

    it('should stop polling after repeated retrieval failures', async () => {
      mockBatchesCreate.mockResolvedValue({ id: 'msgbatch_123', processing_status: 'in_progress' });
      mockBatchesRetrieve.mockRejectedValue(new Error('Unauthorized'));

      await expect(sendPromptToClaude('Review this code', { batch: true })).rejects.toThrow(
        'Unable to poll Claude message batch msgbatch_123 after 3 attempts: Unauthorized'
      );
      expect(mockBatchesRetrieve).toHaveBeenCalledTimes(3);
    });

    it.each([
      [{ type: 'errored', error: { error: { message: 'Request overloaded' } } }, 'Claude batch request errored: Request overloaded'],
      [{ type: 'canceled' }, 'Claude batch request canceled'],
      [{ type: 'expired' }, 'Claude batch request expired'],
    ])('should report an unsuccessful batch result', async (batchResult, expectedMessage) => {
      mockBatchesCreate.mockResolvedValue({ id: 'msgbatch_123', processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(batchResults({ custom_id: 'codecritique-review', result: batchResult }));

      await expect(sendPromptToClaude('Review this code', { batch: true })).rejects.toThrow(expectedMessage);
    });

    it('should reject a batch response without the review result', async () => {
      mockBatchesCreate.mockResolvedValue({ id: 'msgbatch_123', processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(batchResults());

      await expect(sendPromptToClaude('Review this code', { batch: true })).rejects.toThrow(
        'Claude batch response did not contain the review request'
      );
    });
  });

  describe('structured JSON response with tool calling', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        summary: { type: 'string' },
      },
    };

    it('should use tool calling for structured output', async () => {
      const structuredData = {
        issues: [{ severity: 'high', description: 'Missing error handling' }],
        summary: 'Code needs improvement',
      };

      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            name: 'return_json',
            input: structuredData,
          },
        ],
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = await sendPromptToClaude('Review this code', {
        jsonSchema,
      });

      expect(result.json).toEqual(structuredData);
      expect(result.content).toBe(JSON.stringify(structuredData, null, 2));
    });

    it('should include tool definition in request', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'return_json', input: {} }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await sendPromptToClaude('Test', { jsonSchema });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              name: 'return_json',
              input_schema: jsonSchema,
            }),
          ],
          tool_choice: { type: 'tool', name: 'return_json' },
        })
      );
    });

    it('should throw error if no tool_use block in response', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Unexpected text response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await expect(sendPromptToClaude('Test', { jsonSchema })).rejects.toThrow('No structured output received from Claude');
    });

    it('should throw error if tool_use block has wrong name', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'wrong_tool', input: {} }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await expect(sendPromptToClaude('Test', { jsonSchema })).rejects.toThrow('No structured output received from Claude');
    });
  });

  describe('error handling', () => {
    it('should throw error when no credentials are configured', async () => {
      // Reset modules to clear cached anthropic client
      vi.resetModules();
      delete process.env.ANTHROPIC_API_KEY;

      // Re-import the module after resetting (dynamic import needed to test module-level caching)
      // eslint-disable-next-line no-restricted-syntax
      const { sendPromptToClaude: freshSendPrompt } = await import('./llm.js');

      await expect(freshSendPrompt('Test')).rejects.toThrow('No Anthropic credentials found');
    });

    it('should propagate API errors', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(sendPromptToClaude('Test')).rejects.toThrow('Rate limit exceeded');
    });

    it('should log error before throwing', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('API Error'));

      await expect(sendPromptToClaude('Test')).rejects.toThrow();

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('system prompt', () => {
    it('should use default system prompt when not provided', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await sendPromptToClaude('Test');

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('expert code reviewer'),
        })
      );
    });

    it('should use custom system prompt when provided', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      const customSystem = 'You are a security expert';
      await sendPromptToClaude('Test', { system: customSystem });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: [
            {
              type: 'text',
              text: customSystem,
              cache_control: { type: 'ephemeral' },
            },
          ],
        })
      );
    });

    it('should append additional cached system blocks', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await sendPromptToClaude('Test', {
        system: 'Base review rules',
        cachedSystemBlocks: ['Custom project instructions', 'Project architecture context'],
      });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: [
            {
              type: 'text',
              text: 'Base review rules',
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: 'Custom project instructions',
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: 'Project architecture context',
              cache_control: { type: 'ephemeral' },
            },
          ],
        })
      );
    });

    it('should include extra system blocks without exceeding cache breakpoint limits', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await sendPromptToClaude('Test', {
        system: 'Base review rules',
        cachedSystemBlocks: ['Block 1', 'Block 2', 'Block 3', 'Block 4'],
      });

      const request = mockMessagesCreate.mock.calls.at(-1)[0];
      expect(request.system).toHaveLength(5);
      expect(request.system.filter((block) => block.cache_control)).toHaveLength(4);
      expect(request.system.at(-1)).toEqual({
        type: 'text',
        text: 'Block 4',
      });
    });
  });

  describe('message format', () => {
    it('should send prompt as user message', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        usage: {},
      });

      await sendPromptToClaude('Review this code:\n```js\nconst x = 1;\n```');

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: 'Review this code:\n```js\nconst x = 1;\n```',
            },
          ],
        })
      );
    });
  });
});

describe('Workload Identity Federation', () => {
  const federationEnv = {
    ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
    ANTHROPIC_ORGANIZATION_ID: 'org-test',
    ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example.test/request?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-request-token',
  };

  async function sendWithFreshModule() {
    vi.resetModules();
    // eslint-disable-next-line no-restricted-syntax
    const { sendPromptToClaude: freshSendPrompt } = await import('./llm.js');
    return freshSendPrompt('Test');
  }

  beforeEach(() => {
    mockConsoleSelective('log', 'error');
    mockAnthropicConstructor.mockClear();
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Response' }],
      model: 'claude-sonnet-5',
      usage: {},
    });
    Object.assign(process.env, federationEnv);
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    for (const key of [...Object.keys(federationEnv), 'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'ANTHROPIC_BASE_URL']) {
      delete process.env[key];
    }
    vi.unstubAllGlobals();
  });

  function stubFetch({ oidcStatus = 200 } = {}) {
    let jwtCount = 0;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).startsWith('https://token.actions.example.test/')) {
        jwtCount += 1;
        return oidcStatus === 200 ? Response.json({ value: `github-jwt-${jwtCount}` }) : new Response(null, { status: oidcStatus });
      }
      return Response.json({ access_token: `sk-ant-oat01-${jwtCount}`, expires_in: 600, token_type: 'Bearer' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function federatedCredentials() {
    await sendWithFreshModule();
    return mockAnthropicConstructor.mock.lastCall[0].credentials;
  }

  it('exchanges a new GitHub Actions OIDC token on every token exchange', async () => {
    const fetchMock = stubFetch();

    await sendWithFreshModule();
    const options = mockAnthropicConstructor.mock.lastCall[0];
    expect(options.authToken).toBeNull();
    const { credentials } = options;

    await expect(credentials()).resolves.toMatchObject({ token: 'sk-ant-oat01-1' });
    await expect(credentials()).resolves.toMatchObject({ token: 'sk-ant-oat01-2' });

    const [oidcUrl, oidcInit] = fetchMock.mock.calls[0];
    expect(oidcUrl.searchParams.get('audience')).toBe('https://api.anthropic.com');
    expect(oidcUrl.searchParams.get('api-version')).toBe('2.0');
    expect(oidcInit.headers.Authorization).toBe('Bearer actions-request-token');

    const exchanges = fetchMock.mock.calls.filter(([url]) => String(url) === 'https://api.anthropic.com/v1/oauth/token');
    expect(exchanges.map(([, init]) => JSON.parse(init.body))).toEqual([
      expect.objectContaining({
        assertion: 'github-jwt-1',
        federation_rule_id: 'fdrl_test',
        organization_id: 'org-test',
        service_account_id: 'svac_test',
      }),
      expect.objectContaining({ assertion: 'github-jwt-2' }),
    ]);
  });

  it('uses the API key when both an API key and federation are configured', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    await sendWithFreshModule();

    expect(mockAnthropicConstructor).toHaveBeenLastCalledWith({ apiKey: 'test-api-key' });
  });

  it('sends the workspace ID to the token endpoint at ANTHROPIC_BASE_URL', async () => {
    process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_test';
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test';
    const fetchMock = stubFetch();

    await (
      await federatedCredentials()
    )();

    const [exchangeUrl, exchangeInit] = fetchMock.mock.calls[1];
    expect(String(exchangeUrl)).toBe('https://proxy.example.test/v1/oauth/token');
    expect(JSON.parse(exchangeInit.body)).toMatchObject({ workspace_id: 'wrkspc_test' });
  });

  it('reports a failed GitHub Actions OIDC token request', async () => {
    stubFetch({ oidcStatus: 403 });

    await expect((await federatedCredentials())()).rejects.toThrow('GitHub Actions OIDC token request failed with status 403');
  });

  it('does not use federation outside GitHub Actions', async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

    await expect(sendWithFreshModule()).rejects.toThrow('No Anthropic credentials found');
  });

  it.each(['ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID'])('rejects federation without %s', async (missing) => {
    delete process.env[missing];

    await expect(sendWithFreshModule()).rejects.toThrow('requires ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_SERVICE_ACCOUNT_ID');
  });
});
