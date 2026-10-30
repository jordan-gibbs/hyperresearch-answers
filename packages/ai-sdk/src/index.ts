import { tool } from 'ai';
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
  "Each call is charged to the user's prepaid Hyperresearch Answers balance.";

export const SEARCH_DESCRIPTION =
  "Search the web and Hyperresearch's ~45 structured sources (filings, statistics, registers, scholarly, books). " +
  'Returns ranked raw sources with verbatim passages. No synthesis. Use when you need to read the sources yourself. ' +
  'Modes: standard (5¢, default), max (15¢: every provider plus structured data rows and PDF tables, for hard lookups). ' +
  "Each call is charged to the user's prepaid Hyperresearch Answers balance.";

export interface HyperresearchToolOptions extends HyperresearchClientOptions {
  /** Share one client between tools. */
  client?: HyperresearchClient;
  /** Override the description the model reads. */
  description?: string;
}

export interface HyperresearchAnswerOptions extends HyperresearchToolOptions {
  /** Fix the mode; the model then cannot choose it. */
  mode?: AskMode;
  /** Cap every call, in cents. */
  maxCostCents?: number;
}

export interface HyperresearchSearchOptions extends HyperresearchToolOptions {
  /** Fix the mode; the model then cannot choose it. */
  mode?: SearchMode;
  /** Fix the number of results (1-25). */
  maxResults?: number;
}

const answerInput = z.object({
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

const searchInput = z.object({
  query: z.string().min(1).max(1000).describe('What to find, as a question or a precise phrase.'),
  max_results: z.number().int().min(1).max(25).optional().describe('How many ranked sources to return (1-25, default 10). The price does not change.'),
  mode: z
    .enum(['standard', 'max'])
    .optional()
    .describe('standard (5¢, default) or max (15¢: every provider, plus structured data rows and PDF tables, for hard lookups).'),
});

/**
 * `hyperresearchAnswer()`: the `ask` tool. One question in, one checked answer
 * (or `not_found`) out, with the quotes it rests on.
 *
 * ```ts
 * import { generateText, isStepCount } from 'ai';
 * import { hyperresearchAnswer } from '@hyperresearch/ai-sdk';
 *
 * const { text } = await generateText({
 *   model: 'openai/gpt-5-mini',
 *   prompt: 'How old must a US senator be?',
 *   tools: { answer: hyperresearchAnswer() },
 *   stopWhen: isStepCount(3),
 * });
 * ```
 */
export function hyperresearchAnswer(options: HyperresearchAnswerOptions = {}) {
  const { client: shared, description, mode: fixedMode, maxCostCents, ...clientOptions } = options;
  let client = shared;
  const getClient = () => (client ??= new HyperresearchClient(clientOptions));
  return tool({
    description: description ?? ANSWER_DESCRIPTION,
    inputSchema: answerInput,
    execute: async ({ question, mode, as_of }, { abortSignal }) => {
      const result = await getClient().ask(
        {
          question,
          mode: fixedMode ?? mode ?? 'standard',
          ...(as_of ? { as_of } : {}),
          ...(maxCostCents !== undefined ? { max_cost_cents: maxCostCents } : {}),
        },
        { signal: abortSignal },
      );
      return compactAnswer(result);
    },
  });
}

/**
 * `hyperresearchSearch()`: ranked raw sources with word-for-word passages, for
 * an agent that wants to read the sources itself.
 */
export function hyperresearchSearch(options: HyperresearchSearchOptions = {}) {
  const { client: shared, description, mode: fixedMode, maxResults, ...clientOptions } = options;
  let client = shared;
  const getClient = () => (client ??= new HyperresearchClient(clientOptions));
  return tool({
    description: description ?? SEARCH_DESCRIPTION,
    inputSchema: searchInput,
    execute: async ({ query, max_results, mode }, { abortSignal }) => {
      const result = await getClient().search(
        { query, max_results: maxResults ?? max_results ?? 10, mode: fixedMode ?? mode ?? 'standard' },
        { signal: abortSignal },
      );
      return compactSearch(result);
    },
  });
}

/** Both tools, sharing one client: `tools: { ...hyperresearchTools() }`. */
export function hyperresearchTools(options: HyperresearchToolOptions = {}) {
  const client = options.client ?? new HyperresearchClient(options);
  return {
    hyperresearchAnswer: hyperresearchAnswer({ ...options, client }),
    hyperresearchSearch: hyperresearchSearch({ ...options, client }),
  };
}
