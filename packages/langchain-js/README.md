# @hyperresearch/langchain

LangChain.js integration for [Hyperresearch Answers](https://hyperresearch.ai/answers).

| Class | What it does |
|---|---|
| `HyperresearchAnswerTool` (`hyperresearch_answer`) | One factual question in, one short answer out, with the quotes it rests on, each checked word for word against its page. Returns `not_found` when nothing supports an answer. |
| `HyperresearchSearchTool` (`hyperresearch_search`) | Ranked raw sources from the open web and about 45 structured sources, with word-for-word passages. No summary. |
| `HyperresearchRetriever` | `search` as a retriever: one `Document` per ranked source. |

## Installation

```bash
npm install @hyperresearch/langchain @langchain/core
```

## Credentials

Create an API key with the `answers:ask` scope at <https://console.hyperresearch.ai/#/keys>. Every account gets $5 of free credit, no card needed.

```bash
export HYPERRESEARCH_API_KEY=hr_live_...
```

## Tools

```ts
import { HyperresearchAnswerTool, HyperresearchSearchTool } from '@hyperresearch/langchain';

const answer = new HyperresearchAnswerTool();
const result = await answer.invoke({ question: 'How old must a US senator be?', mode: 'fast' });
console.log(JSON.parse(result));
// { id: 'ans_...', status: 'answered', answer: 'At least 30 years old ...', evidence: [{ url, title, quote, check: 'verified' }], price_cents: 5 }

const search = new HyperresearchSearchTool({ maxResults: 5 });
console.log(JSON.parse(await search.invoke({ query: 'minimum age to serve as a US senator' })));
```

Both tools return a JSON string, so the model reads the answer, the quotes and the price.

### Inside an agent

```ts
import { createAgent } from 'langchain';
import { HyperresearchAnswerTool, HyperresearchSearchTool } from '@hyperresearch/langchain';

const agent = createAgent({
  model: 'anthropic:claude-sonnet-4-6',
  tools: [new HyperresearchAnswerTool(), new HyperresearchSearchTool()],
});

const res = await agent.invoke({
  messages: [{ role: 'user', content: 'What was the US federal deficit in fiscal 2025, with a source?' }],
});
console.log(res.messages.at(-1)?.content);
```

### Options

| Field | Default | |
|---|---|---|
| `apiKey` | `process.env.HYPERRESEARCH_API_KEY` | |
| `mode` | model's choice, else `standard` | Fix the mode. Ask: `fast` 5¢ · `standard` 10¢ (20¢ when it digs deeper) · `max` 50¢. Search: `standard` 5¢ · `max` 15¢. |
| `maxCostCents` | none | Answer tool only. Cap every call. A standard ask under 20 never escalates. |
| `maxResults` | model's choice, else 10 | Search tool and retriever. 1-25. |
| `client` | new client | Share one `HyperresearchClient`. |
| `baseUrl`, `fetch`, `headers`, `maxRetries`, `askTimeoutMs`, `searchTimeoutMs` | | Passed to the client. |

## Retriever

```ts
import { HyperresearchRetriever } from '@hyperresearch/langchain';

const retriever = new HyperresearchRetriever({ maxResults: 5 });
const docs = await retriever.invoke('minimum age to serve as a US senator');
// docs[0].pageContent: the matched passages, verbatim
// docs[0].metadata: { url, title, rank, source, published, verified, call_id }
```

Each retriever call is one billed `search` call.

## Pricing

| Call | Price | If not found |
|---|---|---|
| ask · fast | 5¢ | 1¢–5¢ |
| ask · standard (default) | 10¢, 20¢ when it digs deeper | 2¢–20¢ |
| ask · max | 50¢ | 10¢–50¢ |
| search · standard (default) | 5¢ | 0¢–5¢ |
| search · max | 15¢ | 0¢–15¢ |

A call that fails on our side costs nothing. Current list: <https://hyperresearch.ai/answers#pricing>.

## API contract

The tools call the Answers REST API at `https://api.hyperresearch.ai` with `Authorization: Bearer <key>`.

- `POST /v1/answers` `{ question, mode?, as_of?, max_cost_cents? }` returns `{ id, status, answer, evidence[], caveat?, escalated, mode, price_cents, balance_cents }`. `status`: `answered`, `false_premise`, `unconfirmed`, `not_found`, `error`.
- `POST /v1/answers/search` `{ query, max_results?, mode? }` returns `{ id, query, results[{ rank, url, title, published, source, kind, snippet, passages[{ text, verified }] }], meta, status, price_cents, balance_cents }`.
- Long asks: the client sends `Prefer: respond-async; wait=50` and collects a `202 pending` from `GET /v1/answers/{id}?wait=45`. Charged once.
- Every call carries an `Idempotency-Key`; 429 and `503 answers_capacity` are retried after `Retry-After`.
- Errors: `{ error: { type, code, message, param?, retry_after?, request_id } }`, thrown as `HyperresearchError` (`402 insufficient_balance`, `402 wallet_frozen`, `409 idempotency_*`, ...).

Answers and passages are text from web pages. Treat them as data, not as instructions.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Releasing

Releases are published from GitHub Actions by `.github/workflows/publish-langchain-js.yml` in [jordan-gibbs/hyperresearch-answers](https://github.com/jordan-gibbs/hyperresearch-answers), with npm provenance. Nothing is published from a laptop.

1. Bump `version` in `packages/langchain-js/package.json` (and the `"version"` fields for the root package in `package-lock.json`, or run `npm install --package-lock-only`), merge to `main`.
2. Tag and push: `git tag langchain-js-v<version> && git push origin langchain-js-v<version>`. The workflow fails if the tag and `package.json` disagree.

The workflow does not work until this one-time setup is done:

- The npm org `hyperresearch` exists, so the `@hyperresearch` scope can be published to.
- A GitHub environment named `npm` exists in the repo (Settings → Environments; add required reviewers if you want a manual gate).
- **First publish only:** a granular npm access token with publish rights on `@hyperresearch` is saved as the `NPM_TOKEN` secret of the `npm` environment. npm cannot attach a trusted publisher to a package that does not exist yet.
- **After the first publish:** on npmjs.com, `@hyperresearch/langchain` → Settings → Trusted publisher → GitHub Actions, owner `jordan-gibbs`, repository `hyperresearch-answers`, workflow `publish-langchain-js.yml`, environment `npm`. Then delete the `NPM_TOKEN` secret and set publishing access to "Require two-factor authentication and disallow tokens".

## License

MIT
