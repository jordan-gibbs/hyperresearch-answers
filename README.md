# Hyperresearch Answers (MCP)

<img src="assets/logo-400.png" alt="Hyperresearch" width="96">

Every web search provider has gaps. Each one indexes different pages, misses different sources, and none of them reach the structured data behind most real questions.

Hyperresearch Answers layers four web search engines with about 45 structured sources, including company filings, government statistics, public registers, scholarly indexes and books. Your agent gets one search tool with the gaps filled in.

Every answer is checked word for word against quotes from the pages it cites. If the sources don't back it up, it says `not_found` instead of guessing. Your agent gets the answer and its proof, not whole web pages, so its context stays on your work.

## Tools

- **ask**: one question, one verified answer with its quotes and links. A hard question returns an id instead.
- **get_answer**: collects an answer that is still being worked on, by its id. Free.
- **search**: ranked sources with only the relevant passages, copied word for word, for when your agent should read the evidence itself.

## Install

Server: `https://answers.hyperresearch.ai/mcp` (streamable HTTP). You sign in with your Hyperresearch account the first time a tool is called.

Claude Code:

```bash
claude mcp add --transport http -s user hyperresearch-answers https://answers.hyperresearch.ai/mcp
```

Cline:

```bash
cline mcp install hyperresearch-answers --transport http https://answers.hyperresearch.ai/mcp
```

Agents setting this up for Cline can follow [llms-install.md](llms-install.md).

Gemini CLI:

```bash
gemini extensions install https://github.com/jordan-gibbs/hyperresearch-answers
```

VS Code (GitHub Copilot agent mode):

```bash
code --add-mcp '{"name":"hyperresearch-answers","type":"http","url":"https://answers.hyperresearch.ai/mcp"}'
```

Any MCP client (`mcp.json`):

```json
{
  "mcpServers": {
    "hyperresearch-answers": { "url": "https://answers.hyperresearch.ai/mcp" }
  }
}
```

No browser (CI)? Create an API key at https://console.hyperresearch.ai/#/keys and send it as `Authorization: Bearer <YOUR_API_KEY>`.

## Pricing

Calls are paid from prepaid credit in your Hyperresearch account. Every result shows what it cost and the balance left. New accounts get $5 of free credit, no card. Prices: https://hyperresearch.ai/answers

## SDKs

Optional packages that give your own agent code the same `ask` and `search` tools, over the REST API with an API key (not on npm or PyPI yet):

- Vercel AI SDK: [`@hyperresearch/ai-sdk`](packages/ai-sdk/README.md)
- LangChain (Python): [`langchain-hyperresearch`](packages/langchain-python/README.md)
- LangChain.js: [`@hyperresearch/langchain`](packages/langchain-js/README.md)

## Support

support@hyperresearch.ai · https://hyperresearch.ai/answers


The server is hosted by Hyperresearch; nothing here needs to be installed or run to use it. `packages/` holds the optional SDKs above.
