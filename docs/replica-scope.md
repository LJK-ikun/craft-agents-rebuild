# Craft Agents 复刻范围

本文把原版 Craft Agents 的产品功能和本学习项目当前进度分开记录。原版功能依据原仓库 README 的 Features、Desktop App Features、Architecture 章节及源码目录；后续实现每个模块时，还要进一步对照对应源码。

原版源码：`D:/Project/Craft/craft-agents-oss-main`

## 原版功能清单

| 模块 | 原版已有的能力 | 原版代码入口/证据 | 学习复刻进度 |
| --- | --- | --- | --- |
| 桌面应用 | Electron 主进程、Preload、React Renderer | `apps/electron/src/main`、`preload`、`renderer` | 未开始 |
| 工作区与会话 | 多工作区、多会话、收件箱/归档、标记、状态流转、会话持久化 | `packages/shared/src/sessions`、`config`、README Session Management | 未开始 |
| Agent 对话 | 流式响应、工具执行可视化、实时更新 | `packages/shared/src/agent`、`packages/pi-agent-server` | 简化终端版已完成；流式和 UI 未开始 |
| 模型连接 | Anthropic、Google AI Studio、ChatGPT/Codex、GitHub Copilot、OpenAI 等 | `packages/shared/src/agent`、`auth`、README Multiple LLM Connections | 仅有 OpenAI-compatible 聊天接口 |
| 工具与来源 | MCP、Craft MCP、REST API、Google/Slack/Microsoft、本地文件系统 | `packages/shared/src/sources`、`packages/pi-agent-server/src/tools` | 未开始 |
| 权限 | Explore、Ask to Edit、Auto 等权限模式及规则 | `packages/shared/src/agent` | 未开始 |
| 后台任务与自动化 | 长任务进度、事件/计划触发的自动化 | `packages/shared/src/tasks`、`apps/electron/src`、README Automations | 未开始 |
| 工作区能力 | 动态状态、主题、Workspace Skills | `packages/shared/src/statuses`、`config`、`skills` 相关源码 | 未开始 |
| 文件能力 | 图片/PDF/Office 附件及转换、多文件 Diff | `apps/electron/src`、`packages/pi-agent-server/src/tools/web-fetch.ts` | 未开始 |
| 周边入口 | CLI、服务器、Viewer、Web UI、Session MCP Server | `apps/cli`、`apps/viewer`、`apps/webui`、`packages/server` 等 | 未开始 |

## 当前学习项目

- 已实现：终端连续聊天、OpenAI-compatible 聊天请求、单次运行内的对话消息保留。
- 已准备但尚未接入聊天：知识文档、分块、Embedding 客户端、向量相似度检索。
- RAG 是本项目的额外学习扩展，不计入原版 Craft Agents 的复刻功能。
- 完整复刻仍需实现上表中的原版功能；不能把终端版或 RAG 零件称为完整复刻。

## 实现原则

1. 先对照原版源码确认功能和数据流，再决定学习项目的实现方式。
2. 优先建立端到端可运行的核心链路，再逐步补齐 UI、持久化、权限、来源和周边能力。
3. 每个小阶段只提交相关文件，并记录“原版功能”还是“额外扩展”。
