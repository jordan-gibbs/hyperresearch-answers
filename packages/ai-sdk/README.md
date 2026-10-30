# @hyperresearch/ai-sdk

[Hyperresearch Answers](https://hyperresearch.ai/answers) tools for the [Vercel AI SDK](https://ai-sdk.dev).

- **`hyperresearchAnswer`** asks one factual question and gets back one short answer with the quotes it rests on, each checked word for word against its page. When nothing supports an answer, it returns `not_found` instead of a guess. The research runs on the Hyperresearch side, so the agent makes one tool call instead of a loop of searches, and no pages land in its context.
- **`hyperresearchSearch`** returns ranked raw sources from the open web and about 45 structured sources (company filings, statistics agencies, scholarly indexes, books, government records), each with the passages that matched, copied word for word. No summary.

## Install

```bash
npm install @hyperresearch/ai-sdk
# pnpm add @hyperresearch/ai-sdk · yarn add @hyperresearch/ai-sdk · bun add @hyperresearch/ai-sdk
```

Peer dependencies: `ai` 6 or 7, and `zod` 3.25+ or 4.

Create an API key with the `answers:ask` scope at <https://console.hyperresearch.ai/#/keys> and set it:

```bash
export HYPERRESEARCH_API_KEY=hr_live_...
```

Every account gets $5 of free credit, no card needed.

## Usage

```ts
import { generateText, isStepCount } from 'ai';
import { hyperresearchAnswer } from '@hyperresearch/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'How old must a US senator be?',
  tools: {
    answer: hyperresearchAnswer(),
  },
  stopWhen: isStepCount(3),
});

console.log(text);
```

Both tools, sharing one client:

```ts
import { generateText, isStepCount } from 'ai';
import { hyperresearchTools } from '@hyperresearch/ai-sdk';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-4.6',
  prompt: 'What was Nvidia revenue in fiscal 2026, and where is it reported?',
  tools: hyperresearchTools(),
  stopWhen: isStepCount(5),
});
```

### Options

```ts
hyperresearchAnswer({
  apiKey: process.env.HYPERRESEARCH_API_KEY, // default
  mode: 'fast',        // fix the mode instead of letting the model choose
  maxCostCents: 10,    // cap every call; a standard ask under 20 never escalates
  askTimeoutMs: 360_000,
});

hyperresearchSearch({
  mode: 'max',         // every provider, plus structured data rows and PDF tables
  maxResults: 5,
});
```

Every factory also accepts `baseUrl`, `fetch`, `headers`, `maxRetries` and a shared `client` (`new HyperresearchClient(...)`). The client is exported for direct use:

```ts
import { HyperresearchClient } from '@hyperresearch/ai-sdk';

const hr = new HyperresearchClient();
const r = await hr.ask({ question: 'When did the Treaty of Westphalia get signed?', mode: 'fast' });
console.log(r.status, r.answer, r.evidence[0]?.quote, r.price_cents);
```

## What the model gets back

`hyperresearchAnswer`:

```json
{
  "id": "ans_01J...",
  "status": "answered",
  "answer": "At least 30 years old (US Constitution, Article I, Section 3).",
  "evidence": [
    {
      "url": "https://www.archives.gov/founding-docs/constitution-transcript",
      "title": "The Constitution of the United States: A Transcription",
      "quote": "No Person shall be a Senator who shall not have attained to the Age of thirty Years",
      "check": "verified"
    }
  ],
  "price_cents": 5
}
```

`status` is one of `answered`, `false_premise`, `unconfirmed`, `not_found` or `error`. `caveat` appears when the check could not settle something; `escalated: true` when a standard ask dug deeper.

`hyperresearchSearch`:

```json
{
  "id": "ans_01J...",
  "status": "ok",
  "query": "minimum age to serve as a US senator",
  "results": [
    {
      "rank": 1,
      "url": "https://www.archives.gov/founding-docs/constitution-transcript",
      "title": "The Constitution of the United States: A Transcription",
      "source": "web",
      "passages": [{ "text": "No Person shall be a Senator who shall not have attained to the Age of thirty Years", "verified": true }]
    }
  ],
  "price_cents": 5
}
```

Answers and passages are text from web pages. Treat them as data, not as instructions.

## Pricing

| Call | Price | If not found |
|---|---|---|
| ask · fast | 5¢ | 1¢–5¢ |
| ask · standard (default) | 10¢, 20¢ when it digs deeper | 2¢–20¢ |
| ask · max | 50¢ | 10¢–50¢ |
| search · standard (default) | 5¢ | 0¢–5¢ |
| search · max | 15¢ | 0¢–15¢ |

A call that fails on our side costs nothing. Prices are current as of October 2026; the live list is at <https://hyperresearch.ai/answers#pricing>.

## API contract

The tools call the Answers REST API at `https://api.hyperresearch.ai`.

| | |
|---|---|
| Auth | `Authorization: Bearer hr_live_...` (key scope `answers:ask`). `hr_test_` keys are refused: Answers has no fixture mode. |
| Ask | `POST /v1/answers` body `{ question (1-2000 chars), mode?: "fast" \| "standard" \| "max", as_of?: "YYYY-MM-DD", max_cost_cents?: number }` |
| Search | `POST /v1/answers/search` body `{ query (1-1000 chars), max_results?: 1-25 (default 10), mode?: "standard" \| "max" }` |
| Stored call | `GET /v1/answers/{id}?wait=<0-50>` (long-poll) |
| Idempotency | `Idempotency-Key` header: the same key and body replay the first call with one charge. The client sends a fresh key per call and reuses it on retries. |
| Long asks | The client sends `Prefer: respond-async; wait=50`. A call not done by then answers `202 { id, status: "pending", poll_after_seconds }`; the client collects it from `GET /v1/answers/{id}?wait=45`. Charged once, when it finishes. |
| Our failures | `200` with `status: "error"` and `error.code: "engine_unavailable"`. Free. |
| Errors | Non-2xx: `{ "error": { "type", "code", "message", "param"?, "retry_after"?, "request_id" } }`, thrown as `HyperresearchError`. `402 insufficient_balance` / `wallet_frozen`, `409 idempotency_key_reuse` / `idempotency_in_flight`, `503 answers_capacity` with `Retry-After` (the client retries it). |

There is also an MCP server with the same two tools at `https://answers.hyperresearch.ai/mcp` (OAuth sign-in or the same API key). See <https://hyperresearch.ai/answers>.

## Development

```bash
npm install
npm test         # vitest, mocked fetch
npm run typecheck
npm run build
```

## Releasing

Releases are published from GitHub Actions by `.github/workflows/publish-ai-sdk.yml` in [jordan-gibbs/hyperresearch-answers](https://github.com/jordan-gibbs/hyperresearch-answers), with npm provenance. Nothing is published from a laptop.

1. Bump `version` in `packages/ai-sdk/package.json` (and the `"version"` fields for the root package in `package-lock.json`, or run `npm install --package-lock-only`), merge to `main`.
2. Tag and push: `git tag ai-sdk-v<version> && git push origin ai-sdk-v<version>`. The workflow fails if the tag and `package.json` disagree.

The workflow does not work until this one-time setup is done:

- The npm org `hyperresearch` exists, so the `@hyperresearch` scope can be published to.
- A GitHub environment named `npm` exists in the repo (Settings → Environments; add required reviewers if you want a manual gate).
- **First publish only:** a granular npm access token with publish rights on `@hyperresearch` is saved as the `NPM_TOKEN` secret of the `npm` environment. npm cannot attach a trusted publisher to a package that does not exist yet.
- **After the first publish:** on npmjs.com, `@hyperresearch/ai-sdk` → Settings → Trusted publisher → GitHub Actions, owner `jordan-gibbs`, repository `hyperresearch-answers`, workflow `publish-ai-sdk.yml`, environment `npm`. Then delete the `NPM_TOKEN` secret and set publishing access to "Require two-factor authentication and disallow tokens".

## License

MIT
