import type { AgentBackend } from "./backend/types.ts";

// Agent 作为主进程使用的薄门面，把具体工作交给选中的 SDK 后端。
export class Agent {
  constructor(private readonly backend: AgentBackend) {}

  // 后端内部会运行对应 SDK 的模型与工具循环。
  ask(message: string): Promise<string> {
    return this.backend.ask(message);
  }

  // 切换 Workspace 或会话时释放旧后端资源。
  dispose(): Promise<void> {
    return this.backend.dispose();
  }
}
