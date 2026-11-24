// 后端运行过程中，先支持文本片段、完成和错误三种事件。
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "permission_request"; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: "complete" }
  | { type: "error"; message: string };

// 持久化并展示一次工具调用；启动事件和结果事件会按 toolCallId 合并。
export type ToolActivity = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};

// 每种模型后端都要遵守这个接口。
export interface AgentBackend {
  // chat 会陆续产出事件，所以返回 AsyncGenerator。
  chat(message: string): AsyncGenerator<AgentEvent>;

  // 用户确认工具请求后，由运行中的后端把结果交给实际执行工具的进程。
  respondToPermission?(requestId: string, approved: boolean): void;

  // 权限模式变更后同步给正在运行的 Agent 后端。
  setPermissionMode?(mode: "explore" | "ask" | "execute"): void;

  // 某些后端持有子进程或网络资源，切换会话时需要主动释放。
  dispose?(): Promise<void>;
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
  permissionMode?: "explore" | "ask" | "execute";
  apiKey: string;
  workingDirectory: string;
  systemPrompt?: string;
  sdkSessionId?: string;
  onSdkSessionId?: (sdkSessionId: string) => Promise<void>;
  initialHistory?: Array<{ role: "user" | "assistant"; content: string }>;
};
