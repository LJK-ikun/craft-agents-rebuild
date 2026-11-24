import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import type { BackendConfig } from "../types.ts";

/**
 * 创建一个 Pi SDK 会话。
 *
 * 本函数只负责准备凭证、模型和会话存储；
 * 用户消息与事件流由 PiBackend 负责。
 */
export async function createPiSession(config: BackendConfig): Promise<AgentSession> {
  // Pi 后端需要知道底层模型服务商，例如 anthropic 或 openai。
  const provider = config.piAuthProvider;
  if (!provider) {
    throw new Error("Pi 后端缺少模型服务商配置 piAuthProvider。");
  }

  // 让 Pi SDK 管理 API Key；凭证只保存在当前主进程内存中。
  const authStorage = AuthStorage.inMemory();
  authStorage.set(provider, {
    type: "api_key",
    key: config.apiKey,
  });

  // 模型登记表根据“服务商 + 模型 ID”找到 Pi 可调用的模型定义。
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const model = modelRegistry.find(provider, config.model);
  if (!model) {
    throw new Error(`Pi SDK 中找不到模型：${provider}/${config.model}`);
  }

  // 为这个 Craft 会话单独创建 Pi 日志目录，避免不同会话共用对话历史。
  const sessionDirectory = config.piSessionDirectory;
  if (sessionDirectory) {
    await mkdir(sessionDirectory, { recursive: true });
  }

  // 有目录时继续最近的 Pi 会话；没有配置时使用内存会话作为回退。
  const sessionManager = sessionDirectory
    ? SessionManager.continueRecent(config.workingDirectory, sessionDirectory)
    : SessionManager.inMemory(config.workingDirectory);

  // 创建真正的 Pi AgentSession。Pi SDK 会在该会话中运行模型循环。
  const { session } = await createAgentSession({
    cwd: config.workingDirectory,
    authStorage,
    modelRegistry,
    model,
    sessionManager,

    // 暂时关闭 Pi 自带工具；后续接入 Craft 工具与权限检查。
    tools: [],
  });

  // Pi 0.80.6 没有公开的逐会话 system prompt 参数；沿用原 Craft 的覆盖方式，
  // 同时覆盖当前值、每轮 prompt 的基准值和 SDK 重建提示词时调用的函数。
  if (config.systemPrompt) {
    session.agent.state.systemPrompt = config.systemPrompt;

    const mutableSession = session as unknown as {
      _baseSystemPrompt?: string;
      _rebuildSystemPrompt?: (toolNames: string[]) => string;
    };
    mutableSession._baseSystemPrompt = config.systemPrompt;
    mutableSession._rebuildSystemPrompt = () => config.systemPrompt!;
  }

  return session;
}
