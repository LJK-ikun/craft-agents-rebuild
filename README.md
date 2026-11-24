# Craft Agents Learning Rebuild

A guided educational rebuild inspired by the Craft Agents product. The upstream repository is used as architecture reference; this folder is implemented incrementally from first principles.

## Current milestone: minimal Agent loop

```text
user message → Agent → model provider → assistant response
```

Run with Bun after setting `OPENAI_API_KEY` and `OPENAI_MODEL`. Type `/exit` to quit:

```powershell
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "..."
bun run src/index.ts
```

For an OpenAI-compatible endpoint, set `OPENAI_BASE_URL` too.

## Desktop shell

Install project dependencies with `npm install`. Then start the renderer and desktop shell in two terminals:

```powershell
npm run dev:ui
```

```powershell
npm run dev:desktop
```

## MCP stdio tools

The desktop Agent can load local MCP stdio servers from `.craft/mcp.json` in the selected project folder. Example:

```json
{
  "servers": {
    "project-files": {
      "command": "bun",
      "args": ["x", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

The server's tools are discovered when the Agent starts. In Ask mode, calling an MCP tool asks for approval through the same UI as built-in tools. In Explore mode, external MCP tools are blocked because the app cannot assume that a third-party tool is read-only. MCP servers are child processes, so only add commands you trust; keep credentials in `env` values outside committed project files.

## Learning order

1. Foundations and AI Agent basics
2. Core framework and runtime
3. RAG
4. Tool calling
5. Memory
6. Multi-agent systems
7. LLM fundamentals
8. Engineering practice
9. Prompt engineering
10. Agent evaluation
11. Permission design
12. Context engineering
13. Coding Agent
14. Model fine-tuning integration boundary
15. Agent self-improvement loop
16. Multimodal and realtime interaction
17. Skills
18. Harness engineering
19. Agent safety
