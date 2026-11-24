import { ClaudeBackend } from "./claude-backend.ts";
import { PiBackend, resolvePiServerScript } from "./pi-backend.ts";
import type { AgentBackend, AgentProvider, BackendConfig } from "./types.ts";

// 集中决定使用哪个 SDK 后端；UI/主进程不需要知道 SDK 的构造细节。
export function createBackend(
  provider: AgentProvider,
  config: BackendConfig,
  mainDirectory: string,
): AgentBackend {
  switch (provider) {
    case "anthropic":
      return new ClaudeBackend(config);
    case "pi":
      return new PiBackend(config, resolvePiServerScript(mainDirectory));
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`不支持的 Agent 后端：${exhaustiveCheck}`);
    }
  }
}
