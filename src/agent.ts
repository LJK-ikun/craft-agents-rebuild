import type { AgentBackend, AgentEvent } from "./types.ts";

// Agent 是应用侧门面：它不绑定 Claude 或 Pi 的 SDK。
export class Agent implements AgentBackend {
  constructor(private readonly backend: AgentBackend) {}

  // 把后端事件流原样交给上层调用者。
  chat(message: string): AsyncGenerator<AgentEvent> {
    return this.backend.chat(message);
  }

  // 将工具权限决定转交给真正持有 Pi 子进程的后端。
  respondToPermission(requestId: string, approved: boolean): void {
    this.backend.respondToPermission?.(requestId, approved);
  }

  // 把界面选中的权限模式同步给运行中的后端。
  setPermissionMode(mode: "explore" | "ask" | "execute"): void {
    this.backend.setPermissionMode?.(mode);
  }

  // 将停止当前运行的请求转交给具体后端。
  async cancel(): Promise<void> {
    await this.backend.cancel?.();
  }

  // 把资源释放请求转交给具体后端；没有资源的后端可以不实现它。
  async dispose(): Promise<void> {
    await this.backend.dispose?.();
  }

  // 旧主进程暂时仍用 ask；这里把事件流中的文本收集成完整答案。
  async ask(message: string): Promise<string> {
    let answer = "";

    for await (const event of this.chat(message)) {
      if (event.type === "text_delta") answer += event.text;
      if (event.type === "error") throw new Error(event.message);
    }

    return answer;
  }
}
