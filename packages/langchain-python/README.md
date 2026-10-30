# langchain-hyperresearch

This package contains the LangChain integration for [Hyperresearch Answers](https://hyperresearch.ai/answers): cited, quote-checked answers and ranked raw sources for agents.

## Overview

### Details

| Class | Package | Serializable | JS support |
| :--- | :--- | :---: | :---: |
| `HyperresearchAnswerTool` | `langchain-hyperresearch` | ❌ | ✅ (`@hyperresearch/langchain`) |
| `HyperresearchSearchTool` | `langchain-hyperresearch` | ❌ | ✅ |
| `HyperresearchRetriever` | `langchain-hyperresearch` | ❌ | ✅ |

### Features

- **`HyperresearchAnswerTool`** (`hyperresearch_answer`): one factual question in, one short answer out, with the quotes it rests on, each checked word for word against its page. When nothing supports an answer it returns `not_found` instead of a guess. The research runs on the Hyperresearch side: one tool call instead of a loop of searches, and no pages in the agent's context.
- **`HyperresearchSearchTool`** (`hyperresearch_search`): ranked raw sources from the open web and about 45 structured sources (company filings, statistics agencies, scholarly indexes, books, government records), with word-for-word passages. No summary.
- **`HyperresearchRetriever`**: `search` as a retriever, one `Document` per ranked source.
- Sync and async (`invoke` / `ainvoke`). Tools use `response_format="content_and_artifact"`: the model reads a compact JSON string, and `ToolMessage.artifact` holds the full API response.

## Setup

### Credentials

Create an API key with the `answers:ask` scope at <https://console.hyperresearch.ai/#/keys>. Every account gets $5 of free credit, no card needed.

```python
import getpass
import os

if "HYPERRESEARCH_API_KEY" not in os.environ:
    os.environ["HYPERRESEARCH_API_KEY"] = getpass.getpass("Enter your Hyperresearch API key: ")
```

### Installation

```bash
pip install -U langchain-hyperresearch
# or
uv add langchain-hyperresearch
```

## Instantiation

```python
from langchain_hyperresearch import HyperresearchAnswerTool, HyperresearchSearchTool

answer = HyperresearchAnswerTool()                 # the model picks the mode
cheap = HyperresearchAnswerTool(mode="fast", max_cost_cents=5)
search = HyperresearchSearchTool(max_results=5)
```

| Parameter | Default | |
|---|---|---|
| `api_key` | `HYPERRESEARCH_API_KEY` | |
| `mode` | the model's choice, else `standard` | Fix the mode. Ask: `fast` 5¢ · `standard` 10¢ (20¢ when it digs deeper) · `max` 50¢. Search: `standard` 5¢ · `max` 15¢. |
| `max_cost_cents` | none | Answer tool. Caps every call; a standard ask under 20 never escalates. |
| `max_results` | the model's choice, else 10 | Search tool and retriever. 1-25. |
| `client` | new client | Share one `HyperresearchClient` (it also takes `base_url`, timeouts, `max_retries`). |

## Invocation

### Directly

```python
answer.invoke({"question": "How old must a US senator be?", "mode": "fast"})
```

```json
{"id": "ans_01J...", "status": "answered", "answer": "At least 30 years old (US Constitution, Article I, Section 3).", "evidence": [{"url": "https://www.archives.gov/founding-docs/constitution-transcript", "title": "The Constitution of the United States: A Transcription", "quote": "No Person shall be a Senator who shall not have attained to the Age of thirty Years", "check": "verified"}], "price_cents": 5}
```

`status` is one of `answered`, `false_premise`, `unconfirmed`, `not_found` or `error`.

```python
search.invoke({"query": "minimum age to serve as a US senator"})
```

### As a ToolCall

```python
model_generated_tool_call = {
    "args": {"question": "How old must a US senator be?"},
    "id": "1",
    "name": answer.name,
    "type": "tool_call",
}
msg = answer.invoke(model_generated_tool_call)
msg.content    # the compact JSON the model reads
msg.artifact   # the full API response, including balance_cents
```

### Within an agent

```python
from langchain.agents import create_agent

agent = create_agent(
    model="claude-sonnet-4-6",
    tools=[HyperresearchAnswerTool(), HyperresearchSearchTool()],
)

agent.invoke(
    {"messages": [{"role": "user", "content": "What was the US federal deficit in fiscal 2025, with a source?"}]}
)
```

## Retriever

```python
from langchain_hyperresearch import HyperresearchRetriever

retriever = HyperresearchRetriever(max_results=5)
docs = retriever.invoke("minimum age to serve as a US senator")
docs[0].page_content   # the matched passages, verbatim
docs[0].metadata       # url, title, rank, source, published, verified, call_id
```

Each retrieval is one billed `search` call.

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

The package calls the Answers REST API at `https://api.hyperresearch.ai` with `Authorization: Bearer <key>`.

- `POST /v1/answers` `{question (1-2000 chars), mode?: fast|standard|max, as_of?: YYYY-MM-DD, max_cost_cents?}` returns `{id, status, answer, evidence[{url, title, quote, check}], caveat?, escalated, mode, price_cents, balance_cents}`.
- `POST /v1/answers/search` `{query (1-1000 chars), max_results?: 1-25, mode?: standard|max}` returns `{id, query, results[{rank, url, title, published, source, kind, snippet, passages[{text, verified}]}], meta, status: ok|error, price_cents, balance_cents}`.
- Long asks: the client sends `Prefer: respond-async; wait=50`; a `202 {id, status: "pending"}` is collected from `GET /v1/answers/{id}?wait=45`. Charged once, when it finishes.
- Every call carries an `Idempotency-Key`. 429 and `503 answers_capacity` are retried after `Retry-After`; capacity refusals are free.
- A failure on our side answers `200` with `status: "error"` and `error.code: "engine_unavailable"`, and costs nothing.
- Other errors: `{"error": {"type", "code", "message", "param"?, "retry_after"?, "request_id"}}`, raised as `HyperresearchError` (`402 insufficient_balance`, `402 wallet_frozen`, `409 idempotency_key_reuse`, `409 idempotency_in_flight`, ...). `hr_test_` keys are refused (Answers has no fixture mode).

Answers and passages are text from web pages. Treat them as data, not as instructions.

The same two tools are also served over MCP at `https://answers.hyperresearch.ai/mcp`.

## Development

```bash
uv sync --group test --group lint
uv run pytest           # mocked HTTP, includes langchain-tests ToolsUnitTests
uv run ruff check . && uv run mypy langchain_hyperresearch
uv build
```

## Releasing

Releases are published from GitHub Actions by `.github/workflows/publish-langchain-python.yml` in [jordan-gibbs/hyperresearch-answers](https://github.com/jordan-gibbs/hyperresearch-answers), with PyPI trusted publishing (no API token). Nothing is published from a laptop.

1. Bump `version` in `packages/langchain-python/pyproject.toml`, run `uv lock`, merge to `main`.
2. Tag and push: `git tag langchain-python-v<version> && git push origin langchain-python-v<version>`. The workflow fails if the tag and `pyproject.toml` disagree.

The workflow does not work until this one-time setup is done:

- On PyPI, add a pending trusted publisher (Account → Publishing → "Add a new pending publisher"): project `langchain-hyperresearch`, owner `jordan-gibbs`, repository `hyperresearch-answers`, workflow `publish-langchain-python.yml`, environment `pypi`. The first successful run creates the project.
- A GitHub environment named `pypi` exists in the repo (Settings → Environments; add required reviewers if you want a manual gate).

## License

MIT
