import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqAIProvider } from '../src/infrastructure/ai/groq-ai-provider.js';

const commandResult = {
  intent: 'CREATE_TASK',
  confidence: 0.96,
  needsClarification: false,
  clarificationQuestion: null,
  task: {
    title: 'Prepare deployment notes',
    description: 'Prepare the deployment notes for the release.',
    assigneeNames: ['Philip'],
    groupName: 'Skylora Global Team',
    priority: 'NORMAL',
    publishAtText: null,
    deadlineAtText: 'tomorrow at 5 PM'
  },
  announcement: null
};

describe('GroqAIProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails over to another configured model and validates the command draft', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(commandResult) } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GroqAIProvider({
      apiKey: 'test-key',
      models: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
      timeoutMs: 1000
    });

    const result = await provider.extractCommand({
      text: 'Please have Philip prepare deployment notes by tomorrow at 5 PM.',
      senderRole: 'SUPER_ADMIN',
      timezone: 'Africa/Lagos',
      now: new Date('2026-09-01T12:00:00.000Z'),
      defaultOfficialsGroupName: 'Skylora Global Team'
    });

    expect(result.intent).toBe('CREATE_TASK');
    expect(result.task?.assigneeNames).toEqual(['Philip']);
    expect(result.task?.groupName).toBe('Skylora Global Team');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.model).toBe('openai/gpt-oss-20b');
    expect(secondBody.model).toBe('qwen/qwen3.8-27b');
    expect(firstBody.response_format.json_schema.strict).toBe(true);
  });

  it('uses the deterministic parser when Groq is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const provider = new GroqAIProvider({ apiKey: 'test-key', models: ['openai/gpt-oss-20b'] });

    const result = await provider.extractCommand({
      text: 'Assign Philip to update the website by tomorrow at 5 PM',
      senderRole: 'SUPER_ADMIN',
      timezone: 'Africa/Lagos',
      now: new Date('2026-09-01T12:00:00.000Z'),
      defaultOfficialsGroupName: 'Skylora Global Team'
    });

    expect(result.intent).toBe('CREATE_TASK');
    expect(result.task?.title).toBe('update the website');
  });

  it('uses unrestricted creative drafting instructions without granting operational authority', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'Your sound. Your moment. Your stage.' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GroqAIProvider({ apiKey: 'test-key', models: ['openai/gpt-oss-20b'] });

    const reply = await provider.draftReply({
      userMessage: 'Write a short launch caption for our music event.',
      facts: ['This is content generation only; no announcement has been scheduled.'],
      tone: 'WARM',
      mode: 'CREATIVE',
      fallback: 'Unavailable.'
    });

    expect(reply).toContain('Your sound');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain('freely choose wording');
    expect(body.messages[0].content).toContain('Never say an operation was performed');
  });
});
