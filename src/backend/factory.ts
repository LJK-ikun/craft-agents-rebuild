import { ClaudeBackend } from "./claude-backend.ts";
import { PiBackend } from "./pi-backend.ts";
import type { AgentBackend, BackendConfig } from "../types.ts";

// 根据 provider 选择具体后端；调用方只依赖 AgentBackend 接口。
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.provider) {
    case "anthropic":
      return new ClaudeBackend(config);

    case "pi":
      // PiBackend 把 Pi SDK 的会话事件转换成应用统一的 AgentEvent。
      return new PiBackend(config);
  }
}
