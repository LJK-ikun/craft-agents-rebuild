import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, BackendConfig } from "./types.ts";

// Claude 后端把 Agent 循环交给 Claude Agent SDK；SDK 自己管理模型与工具往返。
export class ClaudeBackend implements AgentBackend {
  constructor(private readonly config: BackendConfig) {}

  async ask(message: string): Promise<string> {
    // 只开放 Read，避免当前阶段无确认机制时模型修改项目文件或执行命令。
    const conversation = query({
      prompt: message,
      options: {
        cwd: this.config.workingDirectory,
        model: this.config.model,
        tools: ["Read"],
        allowedTools: ["Read"],
        permissionMode: "dontAsk",
        maxTurns: 8,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.apiKey,
        },
      },
    });

    const textParts: string[] = [];

    try {
      // SDK 以异步消息流返回过程消息；只收集 assistant 的文本内容。
      for await (const sdkMessage of conversation) {
        if (sdkMessage.type !== "assistant") continue;

        for (const block of sdkMessage.message.content) {
          if (block.type === "text" && block.text.trim()) {
            textParts.push(block.text);
          }
        }
      }
    } finally {
      // 成功或失败都关闭本轮 SDK 查询，回收底层进程和连接。
      conversation.close();
    }

    const answer = textParts.join("\n").trim();
    if (!answer) throw new Error("Claude Agent SDK 没有返回文本回答。");
    return answer;
  }

  async dispose(): Promise<void> {
    // Claude 查询在 ask() 结束时已经关闭，没有跨轮资源需要释放。
  }
}
