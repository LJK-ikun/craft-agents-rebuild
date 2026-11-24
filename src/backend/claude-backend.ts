import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentEvent, BackendConfig } from "../types.ts";

// ClaudeBackend 把 Claude Agent SDK 的消息转换成项目统一的 AgentEvent。
export class ClaudeBackend implements AgentBackend {
  private activeQuery: Query | null = null;
  private activeAbortController: AbortController | null = null;
  private sdkSessionId: string | null;

  constructor(private readonly config: BackendConfig) {
    // 主进程从会话索引传入之前保存的 ID；没有则由 SDK 创建新会话。
    this.sdkSessionId = config.sdkSessionId ?? null;
  }

  // 每次 chat 都返回异步事件流，调用方可以边收边展示。
  async *chat(message: string): AsyncGenerator<AgentEvent> {
    const abortController = new AbortController();
    const prompt = this.buildPrompt(message);
    const currentQuery = query({
      prompt,
      options: {
        cwd: this.config.workingDirectory,
        model: this.config.model,
        systemPrompt: this.config.systemPrompt,
        // 已有 SDK 会话时恢复它，这样模型能看到这条会话此前的上下文。
        ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
        // 当前阶段专注模型后端和事件流，先不开放 Claude 的内置工具。
        tools: [],
        includePartialMessages: true,
        abortController,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.apiKey,
        },
      },
    });

    this.activeQuery = currentQuery;
    this.activeAbortController = abortController;
    let streamedText = false;

    try {
      for await (const sdkMessage of currentQuery) {
        // SDK 首次创建会话时会在消息上带 session_id；持久化后下次可以 resume。
        if (
          "session_id" in sdkMessage &&
          typeof sdkMessage.session_id === "string" &&
          sdkMessage.session_id !== this.sdkSessionId
        ) {
          this.sdkSessionId = sdkMessage.session_id;
          await this.config.onSdkSessionId?.(sdkMessage.session_id);
        }

        // SDK 的 content_block_delta 是逐段文本；这里只转发文本增量。
        if (
          sdkMessage.type === "stream_event" &&
          sdkMessage.event.type === "content_block_delta" &&
          sdkMessage.event.delta.type === "text_delta"
        ) {
          streamedText = true;
          yield { type: "text_delta", text: sdkMessage.event.delta.text };
        }

        // 某些响应路径不包含增量事件，结束时从完整 assistant 消息补文本。
        if (sdkMessage.type === "assistant" && !streamedText) {
          for (const block of sdkMessage.message.content) {
            if (block.type === "text" && block.text) {
              yield { type: "text_delta", text: block.text };
            }
          }
        }
      }

      yield { type: "complete" };
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      currentQuery.close();
      if (this.activeQuery === currentQuery) {
        this.activeQuery = null;
        this.activeAbortController = null;
      }
    }
  }

  // 用户停止生成时，同时通知 SDK 中断当前请求并关闭查询。
  async abort(): Promise<void> {
    this.activeAbortController?.abort();
    this.activeQuery?.close();
  }

  // 老版本只保存了应用侧聊天记录；首轮 Claude 查询把它们作为上下文带入。
  private buildPrompt(message: string): string {
    if (this.sdkSessionId || !this.config.initialHistory?.length) {
      return message;
    }

    const history = this.config.initialHistory
      .slice(-20)
      .map((item) => (item.role === "user" ? "用户" : "助手") + ": " + item.content)
      .join("\n\n");

    return [
      "以下是当前会话此前的对话记录，仅作为背景上下文。",
      "不要重复回答旧问题，请优先处理最后的新问题。",
      "<conversation_history>",
      history,
      "</conversation_history>",
      "当前问题：",
      message,
    ].join("\n");
  }
}
