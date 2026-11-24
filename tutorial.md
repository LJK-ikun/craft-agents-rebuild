# Craft Agents 学习版源码课程

## 项目与学习目标

本课程从 `craft-agents-rebuild` 出发，逐步对照 `Craft/craft-agents-oss-main`，学习如何把一个最小模型对话程序演进为桌面 Agent 产品。目标是能沿代码解释核心链路，并亲手实现主要模块；本课程不把尚未实现的能力写成已交付。

- 学习版版本：`53b4f7d`（检查时工作区未显示已跟踪文件改动）。
- 原项目版本：`5b2cdfb`（检查时存在 `bun.lock`、`base-agent.ts` 改动及多份删除/未跟踪文件；后续结论以检查时工作树为准，不重置或修改）。
- 前置基础：TypeScript/JavaScript、异步函数、HTTP/JSON、React 基础；Electron、Agent、RAG 会在课程中按需补充。
- 学习约定：按课推进；每课先解释真实主链，再由学习者复述或完成小改动。课程标记为“已展开”后才视为学过。

## 覆盖范围与边界

学习版已有终端 Agent、OpenAI 兼容 Provider、Electron 主进程/Preload/React 界面、单一会话 JSONL 持久化、基础窗口管理，以及尚未接入聊天流程的 RAG 组件。原项目还包含多 Agent 后端、会话与工作区管理、多个模型连接、工具与 MCP、权限、任务/自动化、技能、来源和多个应用入口。完整实现这些能力需要沿课程逐步补齐；“RAG”标记为学习扩展，不是原项目复刻功能。

## 课程大纲

| 课次 | 主题与读完能回答的问题 | 必读源码顺序（按执行/理解顺序） | 状态 |
|---|---|---|---|
| 01 | 最小 Agent 对话：一次提问如何进上下文、请求模型并留下回答？ | 学习版 `src/index.ts` → `src/agent.ts` → `src/provider.ts`；原项目 `packages/shared/src/agent/base-agent.ts`（理解边界） | 已展开 |
| 02 | 模型 Provider：如何把 Agent 与具体模型 API 解耦？ | 学习版 `src/provider.ts`；原项目 `packages/shared/src/agent/llm-tool.ts`、`packages/shared/src/agent/backend/` | 大纲 |
| 03 | 桌面请求全链路：Renderer 如何安全调用主进程中的 Agent？ | 学习版 `src/renderer/App.tsx` → `src/renderer/electron-api.d.ts` → `src/preload.ts` → `src/main.ts` | 大纲 |
| 04 | Electron 生命周期与窗口：窗口如何创建、复用和清理？ | 学习版 `src/main.ts` → `src/main/window-manager.ts`；原项目 `apps/electron/src/main/index.ts` → `apps/electron/src/main/window-manager.ts` | 大纲 |
| 05 | 会话持久化：JSONL 如何让重启后的对话继续？ | 学习版 `src/main.ts` → `src/sessions/jsonl-store.ts` → `src/agent.ts`；原项目 `packages/shared/src/sessions/` | 大纲 |
| 06 | 流式 Agent 与 UI 事件：回答如何边生成边显示？ | 原项目 `packages/shared/src/agent/` → `packages/pi-agent-server/` → `apps/electron/src/renderer/`；学习版按证据实现 | 大纲 |
| 07 | 多会话与工作区：会话身份、索引、状态流转如何组织？ | 原项目 `packages/shared/src/sessions/` → `packages/shared/src/workspaces/` → Electron Renderer 对应视图；学习版扩展会话模型 | 大纲 |
| 08 | 工具调用与执行循环：模型如何请求工具，工具结果如何回到上下文？ | 原项目 `packages/shared/src/agent/` → `packages/pi-agent-server/src/tools/` → `packages/shared/src/tools/`（若路径存在则按源码校准） | 大纲 |
| 09 | 权限与安全边界：Explore、Ask to Edit、Auto 等模式如何约束副作用？ | 原项目 `packages/shared/src/agent/`、`packages/shared/src/tools/`、Electron Preload/IPC | 大纲 |
| 10 | Sources 与 MCP：外部服务如何发现、连接并提供给 Agent？ | 原项目 `packages/shared/src/sources/`、`packages/shared/src/mcp/`、`packages/pi-agent-server/src/tools/` | 大纲 |
| 11 | 配置、凭证与多模型连接：模型和密钥如何安全管理？ | 原项目 `packages/shared/src/config/`、`credentials/`、`auth/`；学习版环境配置边界对照 | 大纲 |
| 12 | 后台任务与自动化：长任务如何报告进度，事件如何触发会话？ | 原项目 `packages/shared/src/tasks/`、`automations/`、`scheduler/` 及 Electron 集成 | 大纲 |
| 13 | Skills、mentions 与上下文组装：Agent 如何加载工作区知识？ | 原项目 `packages/shared/src/skills/`、`mentions/`、`prompts/`、`agent/` | 大纲 |
| 14 | RAG 学习扩展：当前分块、Embedding、检索如何组成可接入的检索链？ | 学习版 `src/rag/chunker.ts` → `embedder.ts` → `retriever.ts`；标明与原项目功能边界 | 大纲 |
| 15 | 应用边界与交付：CLI、Viewer、Web UI、Server 如何复用核心能力？ | 原项目 `apps/cli/`、`viewer/`、`webui/`、`packages/server/`、根 `package.json` | 大纲 |

> 说明：原项目目录和模块可能随本地分支变化；展开每课前先验证路径、符号和当前行为，必要时调整课程范围。课程 08 的候选路径尤其需要在展开时由实际符号校准。

## 第 01 课：最小 Agent 对话

**读完能回答：** 用户输入如何变成模型请求？Agent 为什么保留消息列表？Provider 抽象了什么？失败时消息状态会怎样？

**主链：** 终端读入 → `Agent.ask` 追加用户消息 → `ChatModelProvider.complete` → HTTP Chat Completions → 取出回答 → Agent 追加助手消息 → 输出到终端。

### 必读路径

1. `src/index.ts` / `createInterface` 与 `while` 循环：读取配置、构造 Provider 和 Agent；每轮读取输入并调用 `agent.ask`。输入是终端文本，下一步是 Agent；输出为终端打印或错误信息。
2. `src/agent.ts` / `Agent` 构造器与 `ask`：构造器把 system prompt 放在历史之前；`ask` 先追加 user，再调用 Provider，成功后追加 assistant 并返回文本。
3. `src/provider.ts` / `ChatMessage`、`ChatModelProvider.complete`、`OpenAICompatibleProvider.complete`：Provider 接收完整消息数组，将其编码为 HTTP JSON；检查 HTTP 状态并从 `choices[0].message.content` 读取结果。
4. 回到 `src/index.ts`：成功结果打印；单轮异常被捕获后允许继续下一轮，`/exit` 退出并在 `finally` 关闭 readline。

### 关键边界与分支

- `ChatModelProvider` 是 Agent 所依赖的接口；当前只有 OpenAI-compatible 实现。它隔离的是调用约定，不代表已经支持原项目的多个 Provider。
- 当前消息只在 Agent 实例内存中累积；终端版没有磁盘持久化。Electron 版的恢复由后续第 05 课说明。
- `Agent.ask` 在模型调用成功前已将用户消息加入数组；失败时没有回滚该条消息，也没有追加 assistant。终端捕获异常后继续，但 Agent 会保留失败轮的 user 消息。此行为是当前实现事实。
- Provider 对非 2xx 响应抛错；响应内容为空也抛错。这里没有自动重试、超时或流式解析。

### 完整流程串联

输入“你好”：`index.ts` 读取字符串并调用 `ask`；Agent 消息数组先后包含 system、user；Provider 将整个数组 POST 到 `/chat/completions`；成功后返回文本，Agent 追加 assistant；终端显示回答。若 HTTP 返回错误，Provider 抛错，`index.ts` 打印错误并继续读取；失败的 user 消息仍在上下文中。

**复述任务：** 不看代码，用自己的话描述从 `terminal.question` 到模型回答打印出来的完整顺序，并指出模型请求失败后 Agent 的消息列表会留下什么。

**下一步实现练习：** 先口头完成复述；之后我们一起给 `Agent.ask` 增加失败回滚，并讨论该回滚对重试和上下文的影响。
