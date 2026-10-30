import { describe, expect, it, vi } from 'vitest';
import { HyperresearchAnswerTool, HyperresearchClient, HyperresearchError, HyperresearchRetriever, HyperresearchSearchTool } from '../src/index.js';

const QUOTE = 'No Person shall be a Senator who shall not have attained to the Age of thirty Years';
const URL1 = 'https://www.archives.gov/founding-docs/constitution-transcript';

const ANSWERED = {
  id: 'ans_01',
  status: 'answered',
  answer: 'At least 30 years old (US Constitution, Article I, Section 3).',
  evidence: [{ url: URL1, title: 'The Constitution', quote: QUOTE, check: 'verified' }],
  escalated: false,
  mode: 'fast',
  price_cents: 5,
  balance_cents: 495,
};

const SEARCHED = {
  id: 'ans_02',
  query: 'minimum age to serve as a US senator',
  results: [
    { rank: 1, url: URL1, title: 'The Constitution', source: 'web', kind: 'web', passages: [{ text: QUOTE, verified: true }] },
    { rank: 2, url: 'https://constitution.congress.gov/browse/article-1/section-3/', title: 'Article I Section 3', source: 'web', snippet: 'Senate qualifications', passages: [] },
  ],
  meta: { ms: 800 },
  status: 'ok',
  mode: 'standard',
  price_cents: 5,
  balance_cents: 490,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', ...next.headers } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('HyperresearchAnswerTool', () => {
  it('invokes POST /v1/answers and returns a JSON string', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ANSWERED }]);
    const tool = new HyperresearchAnswerTool({ apiKey: 'hr_live_test', fetch });
    expect(tool.name).toBe('hyperresearch_answer');
    const out = await tool.invoke({ question: 'How old must a US senator be?', mode: 'fast' });
    expect(typeof out).toBe('string');
    expect(JSON.parse(out as string)).toEqual({
      id: 'ans_01',
      status: 'answered',
      answer: ANSWERED.answer,
      evidence: [{ url: URL1, title: 'The Constitution', quote: QUOTE, check: 'verified' }],
      price_cents: 5,
    });
    expect(calls[0]!.url).toBe('https://api.hyperresearch.ai/v1/answers');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer hr_live_test');
    expect(calls[0]!.headers['Prefer']).toMatch(/^respond-async/);
    expect(calls[0]!.body).toEqual({ question: 'How old must a US senator be?', mode: 'fast' });
  });

  it('returns a ToolMessage for a model-generated ToolCall', async () => {
    const { fetch } = mockFetch([{ status: 200, body: ANSWERED }]);
    const tool = new HyperresearchAnswerTool({ apiKey: 'k', fetch, mode: 'max', maxCostCents: 50 });
    const msg = await tool.invoke({ args: { question: 'q' }, id: 'call_1', name: tool.name, type: 'tool_call' });
    expect(msg.constructor.name).toBe('ToolMessage');
    expect(msg.tool_call_id).toBe('call_1');
    expect(JSON.parse(msg.content as string)['status']).toBe('answered');
  });

  it('applies fixed mode and cost cap', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ANSWERED }]);
    await new HyperresearchAnswerTool({ apiKey: 'k', fetch, mode: 'max', maxCostCents: 50 }).invoke({ question: 'q', mode: 'fast' });
    expect(calls[0]!.body).toEqual({ question: 'q', mode: 'max', max_cost_cents: 50 });
  });

  it('collects a pending ask', async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: 'ans_09', status: 'pending', poll_after_seconds: 15 } },
      { status: 200, body: { ...ANSWERED, id: 'ans_09' } },
    ]);
    const out = JSON.parse((await new HyperresearchAnswerTool({ apiKey: 'k', fetch }).invoke({ question: 'q' })) as string);
    expect(out.id).toBe('ans_09');
    expect(calls[1]!.url).toBe('https://api.hyperresearch.ai/v1/answers/ans_09?wait=45');
  });

  it('rejects invalid input before any call', async () => {
    const { fetch, calls } = mockFetch([]);
    await expect(new HyperresearchAnswerTool({ apiKey: 'k', fetch }).invoke({ question: '' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('surfaces API errors as HyperresearchError', async () => {
    const { fetch } = mockFetch([{ status: 402, body: { error: { type: 'quota_exceeded', code: 'insufficient_balance', message: 'Top up.', request_id: 'r' } } }]);
    const err = await new HyperresearchAnswerTool({ apiKey: 'k', fetch }).invoke({ question: 'q' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HyperresearchError);
    expect(err).toMatchObject({ status: 402, code: 'insufficient_balance' });
  });
});

describe('HyperresearchSearchTool', () => {
  it('invokes POST /v1/answers/search', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: SEARCHED }]);
    const tool = new HyperresearchSearchTool({ apiKey: 'k', fetch, maxResults: 5 });
    const out = JSON.parse((await tool.invoke({ query: SEARCHED.query, mode: 'max' })) as string);
    expect(calls[0]!.url).toBe('https://api.hyperresearch.ai/v1/answers/search');
    expect(calls[0]!.body).toEqual({ query: SEARCHED.query, max_results: 5, mode: 'max' });
    expect(out.results[0].passages).toEqual([{ text: QUOTE, verified: true }]);
    expect(out.price_cents).toBe(5);
  });
});

describe('HyperresearchRetriever', () => {
  it('maps ranked sources to Documents', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: SEARCHED }]);
    const client = new HyperresearchClient({ apiKey: 'k', fetch });
    const docs = await new HyperresearchRetriever({ client, maxResults: 2 }).invoke(SEARCHED.query);
    expect(calls[0]!.body).toEqual({ query: SEARCHED.query, max_results: 2, mode: 'standard' });
    expect(docs).toHaveLength(2);
    expect(docs[0]!.pageContent).toBe(QUOTE);
    expect(docs[0]!.metadata).toMatchObject({ url: URL1, title: 'The Constitution', rank: 1, source: 'web', verified: true, call_id: 'ans_02' });
    expect(docs[1]!.pageContent).toBe('Senate qualifications');
  });
});
