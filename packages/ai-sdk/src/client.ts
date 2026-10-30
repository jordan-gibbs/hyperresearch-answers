/**
 * A small client for the Hyperresearch Answers REST API.
 *
 *   POST /v1/answers          ask: one short answer checked against quoted sources, or an honest not_found
 *   POST /v1/answers/search   search: ranked sources with word-for-word passages, no synthesis
 *   GET  /v1/answers/{id}     a stored call (used to collect an ask that came back 202 pending)
 *
 * Auth is `Authorization: Bearer <hr_live_... key>` with the `answers:ask` scope.
 * Every call is billed from the account's prepaid Answers balance.
 */

export const DEFAULT_BASE_URL = 'https://api.hyperresearch.ai';
export const API_KEY_ENV = 'HYPERRESEARCH_API_KEY';
export const BASE_URL_ENV = 'HYPERRESEARCH_BASE_URL';
export const PACKAGE_VERSION = '0.1.0';

export type AskMode = 'fast' | 'standard' | 'max';
export type SearchMode = 'standard' | 'max';
export type AnswerStatus = 'answered' | 'false_premise' | 'unconfirmed' | 'not_found' | 'error';

export interface AskParams {
  /** One factual question, 1-2000 characters. */
  question: string;
  /** fast 5¢ · standard 10¢ (20¢ when it digs deeper) · max 50¢. Default standard. */
  mode?: AskMode;
  /** Answer as of this date, YYYY-MM-DD. */
  as_of?: string;
  /** The most this call may cost, in cents. Below the mode price the call is refused. */
  max_cost_cents?: number;
}

export interface SearchParams {
  /** What to find, as a question or a precise phrase. 1-1000 characters. */
  query: string;
  /** 1-25, default 10. The price does not change. */
  max_results?: number;
  /** standard 5¢ · max 15¢. Default standard. */
  mode?: SearchMode;
}

export interface Evidence {
  url: string;
  title?: string;
  /** Copied word for word from the page. */
  quote: string;
  /** How the quote checked against its page, e.g. `verified`. */
  check?: string;
  page_verified?: boolean;
  [key: string]: unknown;
}

export interface AnswerResult {
  id: string;
  call_id?: string;
  status: AnswerStatus;
  answer: string;
  evidence: Evidence[];
  sources_consulted?: number;
  check?: string;
  ms?: number;
  /** True when a standard ask dug deeper and was charged the escalated price. */
  escalated?: boolean;
  /** What the check could not settle, when there is something. */
  caveat?: string;
  mode?: AskMode;
  /** What this call cost, in cents (may be fractional). */
  price_cents: number | null;
  /** Wallet balance after the call, in cents. Absent when the answer was collected by polling. */
  balance_cents?: number;
  error?: { code: string; reason?: string; message: string };
  [key: string]: unknown;
}

export interface Passage {
  text: string;
  verified?: boolean;
}

export interface SearchResultItem {
  rank?: number;
  url: string;
  title?: string;
  published?: string;
  /** `web`, or the structured source the row came from. */
  source?: string;
  kind?: string;
  snippet?: string;
  passages?: Passage[];
  [key: string]: unknown;
}

export interface SearchResponse {
  id: string;
  query: string;
  results: SearchResultItem[];
  meta: Record<string, unknown>;
  status: 'ok' | 'error';
  mode?: SearchMode;
  price_cents: number;
  balance_cents?: number;
  [key: string]: unknown;
}

export interface HyperresearchClientOptions {
  /** Defaults to process.env.HYPERRESEARCH_API_KEY. */
  apiKey?: string;
  /** Defaults to process.env.HYPERRESEARCH_BASE_URL, then https://api.hyperresearch.ai. */
  baseUrl?: string;
  /** Inject a fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** How long an ask may take end to end, including polling. Default 6 minutes (max mode runs up to about 5). */
  askTimeoutMs?: number;
  /** How long a search may take. Default 90 seconds. */
  searchTimeoutMs?: number;
  /** Retries on 429/503 (capacity), honouring Retry-After. Default 2. */
  maxRetries?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

/** A non-2xx response, carrying the API's error envelope. */
export class HyperresearchError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly body?: unknown;

  constructor(status: number, message: string, details: Partial<Omit<HyperresearchError, 'status' | 'message' | 'name'>> = {}) {
    super(message);
    this.name = 'HyperresearchError';
    this.status = status;
    Object.assign(this, details);
  }
}

const env = (name: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
};

const POLL_WAIT_SECONDS = 45;
const MAX_RETRY_DELAY_MS = 30_000;

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `hr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class HyperresearchClient {
  private readonly apiKey: string | undefined;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly askTimeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;
  /** Test seam: how the client waits between retries. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(options: HyperresearchClientOptions = {}) {
    this.apiKey = options.apiKey ?? env(API_KEY_ENV);
    this.baseUrl = (options.baseUrl ?? env(BASE_URL_ENV) ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error('No fetch available. Pass `fetch` in the options (Node 18+ has one built in).');
    this.fetchImpl = f;
    this.askTimeoutMs = options.askTimeoutMs ?? 6 * 60_000;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 90_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.extraHeaders = options.headers ?? {};
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.apiKey) {
      throw new HyperresearchError(401, `No Hyperresearch API key. Set ${API_KEY_ENV} or pass apiKey. Create one with the answers:ask scope at https://console.hyperresearch.ai/#/keys`, {
        code: 'missing_api_key',
      });
    }
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'X-Hyperresearch-Client': `hyperresearch-js/${PACKAGE_VERSION}`,
      ...this.extraHeaders,
      ...extra,
    };
  }

  private async request(method: 'GET' | 'POST', path: string, init: { body?: unknown; headers?: Record<string, string>; signal: AbortSignal }): Promise<{ status: number; body: Record<string, unknown> }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers({ ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers }),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { raw: text };
      }
      if (res.ok) return { status: res.status, body };

      const err = (body['error'] && typeof body['error'] === 'object' ? body['error'] : {}) as Record<string, unknown>;
      const headerRetry = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      const retryAfter = typeof err['retry_after'] === 'number' ? (err['retry_after'] as number) : Number.isFinite(headerRetry) ? headerRetry : undefined;
      // 429 and 503 (Answers at capacity) are free and safe to retry with the same Idempotency-Key.
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        await this.sleep(Math.min((retryAfter ?? 2 ** attempt) * 1000, MAX_RETRY_DELAY_MS));
        continue;
      }
      throw new HyperresearchError(res.status, typeof err['message'] === 'string' ? (err['message'] as string) : `Hyperresearch API error ${res.status}`, {
        type: err['type'] as string | undefined,
        code: err['code'] as string | undefined,
        param: err['param'] as string | undefined,
        requestId: err['request_id'] as string | undefined,
        retryAfter,
        body,
      });
    }
  }

  /**
   * Ask one question. Long asks are requested with `Prefer: respond-async`, and
   * a 202 `pending` is collected from GET /v1/answers/{id} (charged once, when it finishes).
   */
  async ask(params: AskParams, options: { signal?: AbortSignal } = {}): Promise<AnswerResult> {
    const signal = withTimeout(this.askTimeoutMs, options.signal);
    const body: Record<string, unknown> = { question: params.question, mode: params.mode ?? 'standard' };
    if (params.as_of !== undefined) body['as_of'] = params.as_of;
    if (params.max_cost_cents !== undefined) body['max_cost_cents'] = params.max_cost_cents;
    let { status, body: res } = await this.request('POST', '/v1/answers', {
      body,
      headers: { 'Idempotency-Key': newIdempotencyKey(), Prefer: `respond-async; wait=${POLL_WAIT_SECONDS + 5}` },
      signal,
    });
    while (status === 202 || res['status'] === 'pending') {
      const id = String(res['id'] ?? '');
      if (!id) throw new HyperresearchError(status, 'The API answered pending without a call id.', { body: res });
      ({ status, body: res } = await this.request('GET', `/v1/answers/${encodeURIComponent(id)}?wait=${POLL_WAIT_SECONDS}`, { signal }));
    }
    return res as unknown as AnswerResult;
  }

  /** Ranked raw sources with verbatim passages. */
  async search(params: SearchParams, options: { signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const signal = withTimeout(this.searchTimeoutMs, options.signal);
    const body: Record<string, unknown> = { query: params.query, max_results: params.max_results ?? 10, mode: params.mode ?? 'standard' };
    const { body: res } = await this.request('POST', '/v1/answers/search', {
      body,
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      signal,
    });
    return res as unknown as SearchResponse;
  }
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!outer) return t;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn([t, outer]);
  return outer;
}

/** The compact form a model reads: the answer, its quotes, and what it cost. */
export function compactAnswer(r: AnswerResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    status: r.status,
    answer: r.answer,
    evidence: (r.evidence ?? []).map((e) => ({ url: e.url, title: e.title, quote: e.quote, check: e.check })),
  };
  if (r.caveat) out['caveat'] = r.caveat;
  if (r.escalated) out['escalated'] = true;
  if (r.error) out['error'] = r.error;
  out['price_cents'] = r.price_cents;
  return out;
}

export function compactSearch(r: SearchResponse): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    query: r.query,
    results: (r.results ?? []).map((x) => ({
      rank: x.rank,
      url: x.url,
      title: x.title,
      published: x.published,
      source: x.source,
      passages: (x.passages ?? []).map((p) => ({ text: p.text, verified: p.verified })),
    })),
    price_cents: r.price_cents,
  };
}
