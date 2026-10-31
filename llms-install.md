# Installing Hyperresearch Answers (for AI agents)

This is a remote MCP server. There is nothing to download or build.

1. Add the server with the name `hyperresearch-answers` and the URL `https://answers.hyperresearch.ai/mcp`, transport streamable HTTP.
   - Cline CLI: `cline mcp install hyperresearch-answers --transport http https://answers.hyperresearch.ai/mcp`
   - Cline settings JSON (`cline_mcp_settings.json`):
     ```json
     {
       "mcpServers": {
         "hyperresearch-answers": {
           "type": "streamableHttp",
           "url": "https://answers.hyperresearch.ai/mcp"
         }
       }
     }
     ```
2. No API key is needed for the default setup. The first time a tool is called, a browser window opens; the user signs in to (or creates) a Hyperresearch account and approves access.
3. Headless machines only: ask the user to create an API key at https://console.hyperresearch.ai/#/keys, then add the header `Authorization: Bearer <YOUR_API_KEY>` to the server entry. Never write the key into a file that is committed.
4. Verify: call `ask` with `{"question": "What year was the Federal Reserve Act signed, and by which president?"}`. A working install returns an answer (1913, Woodrow Wilson) with a quote and a URL. The result also shows the charge and the remaining balance.

Tools: `ask`, `get_answer` (free; collects a pending answer by id), `search`.
