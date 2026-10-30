import { StructuredTool, type ToolParams } from '@langchain/core/tools';
import { BaseRetriever, type BaseRetrieverInput } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { z } from 'zod';
import {
  HyperresearchClient,
  compactAnswer,
  compactSearch,
  type AskMode,
  type HyperresearchClientOptions,
  type SearchMode,
} from './client.js';

export * from './client.js';

export const ANSWER_DESCRIPTION =
  'Answer one factual question with Hyperresearch Answers. Researches the open web and about 45 structured sources ' +
  '(filings, statistics, registers, scholarly indexes, books) on the server and returns one short answer with the quotes it rests on, ' +
  'each checked word for word against its page, or status not_found when nothing supports an answer. ' +
  'Prefer this over a loop of searches for any factual lookup. Modes: fast (5¢), standard (10¢, 20¢ if it digs deeper; default), max (50¢, numbers confirmed on two sites). ' +
  "Each call is charged to the user's prepaid Hyperresearch Answers balance. Input is JSON.";

export const SEARCH_DESCRIPTION =
  "Search the web and Hyperresearch's ~45 structured sources (filings, statistics, registers, scholarly, books). " +
  'Returns ranked raw sources with verbatim passages. No synthesis. Use when you need to read the sources yourself. ' +
  'Modes: standard (5¢, default), max (15¢: every provider plus structured data rows and PDF tables, for hard lookups). ' +
  "Each call is charged to the user's prepaid Hyperresearch Answers balance. Input is JSON.";

export interface HyperresearchToolFields extends ToolParams, HyperresearchClientOptions {
  /** Share one client between tools and retrievers. */
  client?: HyperresearchClient;
}

const answerSchema = z.object({
  question: z.string().min(1).max(2000).describe('One factual question, asked the way you would ask a researcher.'),
  mode: z
    .enum(['fast', 'standard', 'max'])
    .optional()
    .describe('How hard to look: fast (5¢, about 45 s), standard (10¢, 20¢ if it digs deeper; default, up to about 3 min) or max (50¢, up to about 5 min).'),
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Answer as of this date (YYYY-MM-DD). Omit for today.'),
});

const searchSchema = z.object({
  query: z.string().min(1).max(1000).describe('What to find, as a question or a precise phrase.'),
  max_results: z.number().int().min(1).max(25).optional().describe('How many ranked sources to return (1-25, default 10). The price does not change.'),
  mode: z
    .enum(['standard', 'max'])
    .optional()
    .describe('standard (5¢, default) or max (15¢: every provider, plus structured data rows and PDF tables, for hard lookups).'),
});

function clientFrom(fields: HyperresearchToolFields): HyperresearchClient {
  if (fields.client) return fields.client;
  const { apiKey, baseUrl, fetch, askTimeoutMs, searchTimeoutMs, maxRetries, headers } = fields;
  return new HyperresearchClient({ apiKey, baseUrl, fetch, askTimeoutMs, searchTimeoutMs, maxRetries, headers });
}

export interface HyperresearchAnswerToolFields extends HyperresearchToolFields {
  /** Fix the mode; the model then cannot choose it. */
  mode?: AskMode;
  /** Cap every call, in cents. */
  maxCostCents?: number;
}

/**
 * One factual question in, one short answer with checked quotes (or
 * `not_found`) out. The tool returns a JSON string.
 *
 * ```ts
 * const tool = new HyperresearchAnswerTool();
 * await tool.invoke({ question: "How old must a US senator be?", mode: "fast" });
 * ```
 */
export class HyperresearchAnswerTool extends StructuredTool<typeof answerSchema> {
  static lc_name(): string {
    return 'HyperresearchAnswerTool';
  }

  name = 'hyperresearch_answer';
  description = ANSWER_DESCRIPTION;
  schema = answerSchema;

  client: HyperresearchClient;
  mode?: AskMode;
  maxCostCents?: number;

  constructor(fields: HyperresearchAnswerToolFields = {}) {
    super(fields);
    this.client = clientFrom(fields);
    this.mode = fields.mode;
    this.maxCostCents = fields.maxCostCents;
  }

  protected async _call(input: z.infer<typeof answerSchema>, _runManager?: CallbackManagerForToolRun): Promise<string> {
    const result = await this.client.ask({
      question: input.question,
      mode: this.mode ?? input.mode ?? 'standard',
      ...(input.as_of ? { as_of: input.as_of } : {}),
      ...(this.maxCostCents !== undefined ? { max_cost_cents: this.maxCostCents } : {}),
    });
    return JSON.stringify(compactAnswer(result));
  }
}

export interface HyperresearchSearchToolFields extends HyperresearchToolFields {
  /** Fix the mode; the model then cannot choose it. */
  mode?: SearchMode;
  /** Fix the number of results (1-25). */
  maxResults?: number;
}

/** Ranked raw sources with verbatim passages. The tool returns a JSON string. */
export class HyperresearchSearchTool extends StructuredTool<typeof searchSchema> {
  static lc_name(): string {
    return 'HyperresearchSearchTool';
  }

  name = 'hyperresearch_search';
  description = SEARCH_DESCRIPTION;
  schema = searchSchema;

  client: HyperresearchClient;
  mode?: SearchMode;
  maxResults?: number;

  constructor(fields: HyperresearchSearchToolFields = {}) {
    super(fields);
    this.client = clientFrom(fields);
    this.mode = fields.mode;
    this.maxResults = fields.maxResults;
  }

  protected async _call(input: z.infer<typeof searchSchema>, _runManager?: CallbackManagerForToolRun): Promise<string> {
    const result = await this.client.search({
      query: input.query,
      max_results: this.maxResults ?? input.max_results ?? 10,
      mode: this.mode ?? input.mode ?? 'standard',
    });
    return JSON.stringify(compactSearch(result));
  }
}

export interface HyperresearchRetrieverInput extends BaseRetrieverInput, HyperresearchClientOptions {
  client?: HyperresearchClient;
  /** 1-25, default 10. */
  maxResults?: number;
  mode?: SearchMode;
}

/**
 * A retriever over `search`: one Document per ranked source. `pageContent` is
 * the matched passages (or the snippet), `metadata` carries url, title, rank,
 * source, published and the call id.
 */
export class HyperresearchRetriever extends BaseRetriever {
  static lc_name(): string {
    return 'HyperresearchRetriever';
  }

  lc_namespace = ['hyperresearch', 'retrievers'];

  client: HyperresearchClient;
  maxResults: number;
  mode: SearchMode;

  constructor(fields: HyperresearchRetrieverInput = {}) {
    super(fields);
    this.client = fields.client ?? new HyperresearchClient(fields);
    this.maxResults = fields.maxResults ?? 10;
    this.mode = fields.mode ?? 'standard';
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const res = await this.client.search({ query, max_results: this.maxResults, mode: this.mode });
    return (res.results ?? []).map((r) => {
      const passages = (r.passages ?? []).map((p) => p.text).filter(Boolean);
      return new Document({
        pageContent: passages.length ? passages.join('\n\n') : (r.snippet ?? ''),
        metadata: {
          url: r.url,
          title: r.title,
          rank: r.rank,
          source: r.source,
          published: r.published,
          verified: (r.passages ?? []).every((p) => p.verified !== false),
          call_id: res.id,
        },
      });
    });
  }
}
