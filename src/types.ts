// 后端运行过程中，先支持文本片段、完成和错误三种事件。
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "complete" }
  | { type: "error"; message: string };

// 每种模型后端都要遵守这个接口。
export interface AgentBackend {
  // chat 会陆续产出事件，所以返回 AsyncGenerator。
  chat(message: string): AsyncGenerator<AgentEvent>;
}

// 对齐 Craft 的后端名称：Claude SDK 或 Pi SDK。
export type AgentProvider = "anthropic" | "pi";

// 创建具体后端时，工厂需要的基础配置。
export type BackendConfig = {
  provider: AgentProvider;
  model: string;
  // 仅 Pi 后端使用：指定 Pi SDK 连接哪家模型服务商，例如 anthropic 或 openai。
  piAuthProvider?: string;
  // 当前 Craft 会话专属的 Pi 日志目录，用于恢复同一会话的上下文。
  piSessionDirectory?: string;
  apiKey: string;
  workingDirectory: string;
  systemPrompt?: string;
  sdkSessionId?: string;
  onSdkSessionId?: (sdkSessionId: string) => Promise<void>;
  initialHistory?: Array<{ role: "user" | "assistant"; content: string }>;
};
