# Craft Agents Learning Rebuild

A guided educational rebuild inspired by the Craft Agents product. The upstream repository is used as architecture reference; this folder is implemented incrementally from first principles.

## Current milestone: minimal Agent loop

```text
user message → Agent → model provider → assistant response
```

Run with Bun after setting `OPENAI_API_KEY` and `OPENAI_MODEL`:

```powershell
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "..."
bun run src/index.ts "请用一句话介绍 Agent"
```

For an OpenAI-compatible endpoint, set `OPENAI_BASE_URL` too.

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
