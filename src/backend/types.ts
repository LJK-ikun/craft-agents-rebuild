// Craft 的主进程只依赖这个后端契约，不直接绑定某家模型 SDK。
export interface AgentBackend {
  // 把一次用户输入交给后端，等 Agent 完成工具调用和最终回答。
  ask(message: string): Promise<string>;

  // 释放后端持有的资源，例如 Pi 子进程。
  dispose(): Promise<void>;
}

// 两个后端共用工作目录和模型配置，但各自使用自己的 SDK。
export type BackendConfig = {
  workingDirectory: string;
  model: string;
  apiKey: string;
  provider?: string;
};

// 当前重建版实现的后端标识，对齐原项目的 anthropic / pi 路由。
export type AgentProvider = "anthropic" | "pi";
