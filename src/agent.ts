import type { AgentBackend, AgentEvent } from "./types.ts";

// Agent 是应用侧门面：它不绑定 Claude 或 Pi 的 SDK。
export class Agent implements AgentBackend {
  constructor(private readonly backend: AgentBackend) {}

  // 把后端事件流原样交给上层调用者。
  chat(message: string): AsyncGenerator<AgentEvent> {
    return this.backend.chat(message);
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
