import { ClaudeBackend } from "./claude-backend.ts";
import { PiBackend, resolvePiServerScript } from "./pi-backend.ts";
import type { AgentBackend, BackendConfig } from "../types.ts";

// 根据 provider 选择具体后端；调用方只依赖 AgentBackend 接口。
export function createBackend(
  config: BackendConfig,
  mainDirectory: string,
): AgentBackend {
  switch (config.provider) {
    case "anthropic":
      return new ClaudeBackend(config);

    case "pi":
      // Electron 主进程只创建 JSONL 客户端；Pi SDK 在 Bun 子进程中运行。
      return new PiBackend(config, resolvePiServerScript(mainDirectory));
  }
}
