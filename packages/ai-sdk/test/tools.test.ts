import { describe, expect, it, vi } from 'vitest';
import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  HyperresearchClient,
  HyperresearchError,
  hyperresearchAnswer,
  hyperresearchSearch,
  hyperresearchTools,
} from '../src/index.js';

const QUOTE = 'No Person shall be a Senator who shall not have attained to the Age of thirty Years';

const ANSWERED = {
  id: 'ans_01',
  call_id: 'ans_01',
  status: 'answered',
  answer: 'At least 30 years old (US Constitution, Article I, Section 3).',
  evidence: [{ url: 'https://www.archives.gov/founding-docs/constitution-transcript', title: 'The Constitution', quote: QUOTE, check: 'verified', page_verified: true }],
  sources_consulted: 4,
  check: 'verified',
  escalated: false,
  mode: 'fast',
  price_cents: 5,
  balance_cents: 495,
};

const SEARCHED = {
  id: 'ans_02',
  query: 'minimum age to serve as a US senator',
  results: [
    { rank: 1, url: 'https://www.archives.gov/founding-docs/constitution-transcript', title: 'The Constitution', kind: 'web', source: 'web', passages: [{ text: QUOTE, verified: true }] },
  ],
  meta: { ms: 900, mode: 'standard' },
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

const execOpts = { toolCallId: 't1', messages: [] } as never;

describe('hyperresearchAnswer', () => {
  it('posts to /v1/answers with the bearer key, idempotency key and async preference', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ANSWERED }]);
    const t = hyperresearchAnswer({ apiKey: 'hr_live_test', fetch });
    const out = (await t.execute!({ question: 'How old must a US senator be?', mode: 'fast' }, execOpts)) as Record<string, unknown>;

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://api.hyperresearch.ai/v1/answers');
    expect(c.method).toBe('POST');
    expect(c.headers['Authorization']).toBe('Bearer hr_live_test');
    expect(c.headers['Idempotency-Key']).toMatch(/.{8,}/);
    expect(c.headers['Prefer']).toMatch(/^respond-async; wait=\d+$/);
    expect(c.body).toEqual({ question: 'How old must a US senator be?', mode: 'fast' });

    expect(out).toEqual({
      id: 'ans_01',
      status: 'answered',
      answer: ANSWERED.answer,
      evidence: [{ url: ANSWERED.evidence[0]!.url, title: 'The Constitution', quote: QUOTE, check: 'verified' }],
      price_cents: 5,
    });
  });

  it('defaults to standard and applies fixed mode and cost cap', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: ANSWERED }, { status: 200, body: ANSWERED }]);
    await hyperresearchAnswer({ apiKey: 'k', fetch }).execute!({ question: 'q' }, execOpts);
    await hyperresearchAnswer({ apiKey: 'k', fetch, mode: 'max', maxCostCents: 50 }).execute!({ question: 'q', mode: 'fast', as_of: '2026-01-01' }, execOpts);
    expect(calls[0]!.body).toEqual({ question: 'q', mode: 'standard' });
    expect(calls[1]!.body).toEqual({ question: 'q', mode: 'max', as_of: '2026-01-01', max_cost_cents: 50 });
  });

  it('collects a 202 pending answer from GET /v1/answers/{id}', async () => {
    const pending = { id: 'ans_03', status: 'pending', poll_after_seconds: 15, price_cents_max: 20 };
    const { fetch, calls } = mockFetch([
      { status: 202, body: pending },
      { status: 202, body: pending },
      { status: 200, body: { ...ANSWERED, id: 'ans_03', price_cents: 20, escalated: true } },
    ]);
    const out = (await hyperresearchAnswer({ apiKey: 'k', fetch }).execute!({ question: 'hard one' }, execOpts)) as Record<string, unknown>;
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.hyperresearch.ai/v1/answers',
      'GET https://api.hyperresearch.ai/v1/answers/ans_03?wait=45',
      'GET https://api.hyperresearch.ai/v1/answers/ans_03?wait=45',
    ]);
    expect(out['price_cents']).toBe(20);
    expect(out['escalated']).toBe(true);
  });

  it('returns not_found and engine errors as results, not exceptions', async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { id: 'ans_04', status: 'not_found', answer: 'No source we could read states this figure.', evidence: [], price_cents: 2 } },
      { status: 200, body: { id: 'ans_05', status: 'error', answer: '', evidence: [], price_cents: 0, error: { code: 'engine_unavailable', message: 'Nothing was charged; try again.' } } },
    ]);
    const t = hyperresearchAnswer({ apiKey: 'k', fetch });
    expect(((await t.execute!({ question: 'a' }, execOpts)) as Record<string, unknown>)['status']).toBe('not_found');
    const err = (await t.execute!({ question: 'b' }, execOpts)) as Record<string, unknown>;
    expect(err['status']).toBe('error');
    expect(err['error']).toEqual({ code: 'engine_unavailable', message: 'Nothing was charged; try again.' });
  });
});

describe('hyperresearchSearch', () => {
  it('posts to /v1/answers/search and returns compact results', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: SEARCHED }]);
    const out = (await hyperresearchSearch({ apiKey: 'k', fetch }).execute!({ query: SEARCHED.query }, execOpts)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe('https://api.hyperresearch.ai/v1/answers/search');
    expect(calls[0]!.body).toEqual({ query: SEARCHED.query, max_results: 10, mode: 'standard' });
    expect(calls[0]!.headers['Prefer']).toBeUndefined();
    expect(out).toEqual({
      id: 'ans_02',
      status: 'ok',
      query: SEARCHED.query,
      results: [{ rank: 1, url: SEARCHED.results[0]!.url, title: 'The Constitution', published: undefined, source: 'web', passages: [{ text: QUOTE, verified: true }] }],
      price_cents: 5,
    });
  });

  it('honours fixed maxResults and mode', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: SEARCHED }]);
    await hyperresearchSearch({ apiKey: 'k', fetch, maxResults: 3, mode: 'max' }).execute!({ query: 'x', max_results: 20, mode: 'standard' }, execOpts);
    expect(calls[0]!.body).toEqual({ query: 'x', max_results: 3, mode: 'max' });
  });
});

describe('client', () => {
  it('throws HyperresearchError with the API error envelope', async () => {
    const { fetch } = mockFetch([
      {
        status: 402,
        body: { error: { type: 'quota_exceeded', code: 'insufficient_balance', message: 'Top up to continue.', request_id: 'req_1' } },
      },
    ]);
    const err = await new HyperresearchClient({ apiKey: 'k', fetch }).ask({ question: 'q' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HyperresearchError);
    expect(err).toMatchObject({ status: 402, code: 'insufficient_balance', type: 'quota_exceeded', requestId: 'req_1', message: 'Top up to continue.' });
  });

  it('retries 503 capacity refusals after Retry-After with the same idempotency key', async () => {
    const { fetch, calls } = mockFetch([
      { status: 503, body: { error: { type: 'provider_unavailable', code: 'answers_capacity', message: 'At capacity.', retry_after: 3, request_id: 'r' } }, headers: { 'Retry-After': '3' } },
      { status: 200, body: SEARCHED },
    ]);
    const client = new HyperresearchClient({ apiKey: 'k', fetch });
    const waits: number[] = [];
    client.sleep = async (ms) => {
      waits.push(ms);
    };
    const res = await client.search({ query: 'x' });
    expect(res.status).toBe('ok');
    expect(waits).toEqual([3000]);
    expect(calls[0]!.headers['Idempotency-Key']).toBe(calls[1]!.headers['Idempotency-Key']);
  });

  it('refuses without an API key before calling the network', async () => {
    const { fetch, calls } = mockFetch([]);
    const prev = process.env['HYPERRESEARCH_API_KEY'];
    delete process.env['HYPERRESEARCH_API_KEY'];
    try {
      const err = await new HyperresearchClient({ fetch }).search({ query: 'x' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 401, code: 'missing_api_key' });
      expect(calls).toHaveLength(0);
    } finally {
      if (prev !== undefined) process.env['HYPERRESEARCH_API_KEY'] = prev;
    }
  });

  it('reads the key and base URL from the environment', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: SEARCHED }]);
    process.env['HYPERRESEARCH_API_KEY'] = 'hr_live_env';
    process.env['HYPERRESEARCH_BASE_URL'] = 'https://staging.example.test/';
    try {
      await new HyperresearchClient({ fetch }).search({ query: 'x' });
      expect(calls[0]!.url).toBe('https://staging.example.test/v1/answers/search');
      expect(calls[0]!.headers['Authorization']).toBe('Bearer hr_live_env');
    } finally {
      delete process.env['HYPERRESEARCH_API_KEY'];
      delete process.env['HYPERRESEARCH_BASE_URL'];
    }
  });
});

describe('with generateText', () => {
  it('runs as an AI SDK tool inside a model loop', async () => {
    const { fetch } = mockFetch([{ status: 200, body: ANSWERED }]);
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    };
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step++;
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'answer', input: JSON.stringify({ question: 'How old must a US senator be?', mode: 'fast' }) }],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
            warnings: [],
          };
        }
        return { content: [{ type: 'text', text: 'At least 30.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
      },
    });
    const result = await generateText({
      model,
      prompt: 'How old must a US senator be?',
      tools: { answer: hyperresearchAnswer({ apiKey: 'k', fetch }) },
      stopWhen: isStepCount(3),
    });
    expect(result.text).toBe('At least 30.');
    const toolResult = result.steps[0]!.toolResults[0]!;
    expect((toolResult.output as Record<string, unknown>)['status']).toBe('answered');
  });

  it('hyperresearchTools returns both tools on one client', () => {
    const tools = hyperresearchTools({ apiKey: 'k' });
    expect(Object.keys(tools)).toEqual(['hyperresearchAnswer', 'hyperresearchSearch']);
  });
});
