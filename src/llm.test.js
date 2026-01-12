import { sendPromptToClaude } from './llm.js';

// Create hoisted mock for the Anthropic SDK
const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: class MockAnthropic {
    messages = {
      create: mockMessagesCreate,
    };
  },
}));

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
          model: 'claude-sonnet-4-5',
          max_tokens: 4096,
          temperature: 0.7,
        })
      );
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
          system: 'Custom system prompt',
        })
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
    it('should throw error when API key is missing', async () => {
      // Reset modules to clear cached anthropic client
      vi.resetModules();
      delete process.env.ANTHROPIC_API_KEY;

      // Re-import the module after resetting (dynamic import needed to test module-level caching)
      // eslint-disable-next-line no-restricted-syntax
      const { sendPromptToClaude: freshSendPrompt } = await import('./llm.js');

      await expect(freshSendPrompt('Test')).rejects.toThrow('ANTHROPIC_API_KEY is required');
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
          system: customSystem,
        })
      );
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
