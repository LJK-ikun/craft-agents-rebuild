import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { checkExploreBashCommand } from "./explore-bash-policy.ts";
import type { AgentEvent } from "../types.ts";

// 主进程发给 Pi 子进程的消息类型。
type ServerRequest =
  | {
      type: "init";
      cwd: string;
      provider?: string;
      model: string;
      apiKey: string;
      systemPrompt?: string;
      sessionDirectory?: string;
      permissionMode?: "explore" | "ask" | "execute";
    }
  | { type: "ask"; id: string; message: string }
  | { type: "permission_response"; requestId: string; approved: boolean }
  | { type: "set_permission_mode"; mode: "explore" | "ask" | "execute" }
  | { type: "close" };

// Pi 子进程发回主进程的消息类型。
type ServerResponse =
  | { type: "ready" }
  | { type: "event"; id: string; event: AgentEvent }
  | { type: "permission_request"; id: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "error"; id?: string; message: string };

// stdout 专门作为 JSONL 协议通道；诊断日志写入 stderr。
function send(response: ServerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

let session: AgentSession | null = null;
let activeRequestId: string | null = null;
let unsubscribe: (() => void) | null = null;
let isClosing = false;
// Explore 只读；Ask 对写入/命令逐次确认；Execute 自动放行。
let permissionMode: "explore" | "ask" | "execute" = "ask";
// 已解析为真实路径的工作区根目录，用于拦截文件工具越界访问。
let workspaceRoot = "";
// 每个等待用户确认的工具都用 requestId 对应一个 Promise 回调。
const permissionWaiters = new Map<string, (approved: boolean) => void>();

// 每行是一条独立 JSON 消息，逐条解析并交给对应处理函数。
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void handleLine(line);
});

// 主进程关闭 stdin 时也释放 SDK 会话，避免 Bun 子进程残留。
input.on("close", () => {
  void shutdown();
});

/** 解析一行请求，再按消息类型初始化、提问或关闭 Pi。 */
async function handleLine(line: string): Promise<void> {
  let request: ServerRequest;

  try {
    request = JSON.parse(line) as ServerRequest;
  } catch {
    send({ type: "error", message: "收到无效的 JSONL 请求。" });
    return;
  }

  if (request.type === "init") {
    await initializeSession(request);
    return;
  }

  if (request.type === "close") {
    await shutdown();
    return;
  }

  if (request.type === "permission_response") {
    const resolve = permissionWaiters.get(request.requestId);
    if (resolve) {
      permissionWaiters.delete(request.requestId);
      resolve(request.approved);
    }
    return;
  }

  if (request.type === "set_permission_mode") {
    permissionMode = request.mode;
    return;
  }

  if (!session) {
    send({
      type: "error",
      id: request.id,
      message: "Pi session 尚未初始化。",
    });
    return;
  }

  // 同一个 Pi AgentSession 一次只处理一个 prompt；拒绝重叠调用。
  if (activeRequestId) {
    send({
      type: "error",
      id: request.id,
      message: "Pi session 正在处理上一条问题。",
    });
    return;
  }

  activeRequestId = request.id;
  void runPrompt(request.id, request.message);
}

/** 准备凭证、模型、持久化目录，并创建 Pi AgentSession。 */
async function initializeSession(
  request: Extract<ServerRequest, { type: "init" }>,
): Promise<void> {
  if (session) {
    send({ type: "error", message: "Pi session 已经初始化。" });
    return;
  }

  try {
    const provider = request.provider;
    if (!provider) throw new Error("Pi 初始化缺少模型服务商 provider。");
    permissionMode = request.permissionMode ?? "ask";
    workspaceRoot = await realpath(request.cwd);

    // 凭证只保存在 Pi 子进程的内存里，不写入全局 auth.json。
    const authStorage = AuthStorage.inMemory();
    authStorage.set(provider, {
      type: "api_key",
      key: request.apiKey,
    });

    // 模型登记表按 provider + model ID 找到 Pi 模型定义。
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find(provider, request.model);
    if (!model) {
      throw new Error(`Pi SDK 找不到模型：${provider}/${request.model}`);
    }

    // 每个 Craft 会话使用独立 Pi 日志目录，支持重启后恢复上下文。
    const sessionManager = request.sessionDirectory
      ? await createPersistentSessionManager(request.cwd, request.sessionDirectory)
      : SessionManager.inMemory(request.cwd);

    // Pi 自带的编码工具，先统一包一层权限确认，再交给 AgentSession。
    const tools = [
      createReadToolDefinition(request.cwd),
      createBashToolDefinition(request.cwd),
      createEditToolDefinition(request.cwd),
      createFindToolDefinition(request.cwd),
      createGrepToolDefinition(request.cwd),
      createLsToolDefinition(request.cwd),
      createWriteToolDefinition(request.cwd),
    ].map((tool) => wrapToolWithApproval(tool, workspaceRoot));

    const created = await createAgentSession({
      cwd: request.cwd,
      authStorage,
      modelRegistry,
      model,
      sessionManager,

      // 显式注册包装后的工具；模型每次执行前都会等待用户批准。
      customTools: tools,
      tools: tools.map((tool) => tool.name),
    });
    session = created.session;

    // Pi 0.80.6 没有公开的逐会话 system prompt 参数；沿用原 Craft 的覆盖方式，
    // 让提示词在每轮 prompt 和 SDK 重建系统提示时都保持有效。
    if (request.systemPrompt) {
      session.agent.state.systemPrompt = request.systemPrompt;

      const mutableSession = session as unknown as {
        _baseSystemPrompt?: string;
        _rebuildSystemPrompt?: (toolNames: string[]) => string;
      };
      mutableSession._baseSystemPrompt = request.systemPrompt;
      mutableSession._rebuildSystemPrompt = () => request.systemPrompt!;
    }

    // 订阅 SDK 事件，在事件发生时通过 stdout 转成 JSONL 发回主进程。
    unsubscribe = session.subscribe(handleSessionEvent);
    send({ type: "ready" });
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    // 初始化失败后没有可复用的 session，及时退出让主进程得到明确失败状态。
    await shutdown();
  }
}

/** 工具真正执行前暂停，等待主进程把用户的允许/拒绝结果送回来。 */
async function assertToolPathsInsideWorkspace(
  toolName: string,
  input: Record<string, unknown>,
  allowedRoot: string,
): Promise<void> {
  const rawPath = typeof input.path === "string" ? input.path : ".";
  const requestedPath = path.resolve(allowedRoot, rawPath);

  if (!isPathInside(allowedRoot, requestedPath)) {
    throw new Error(`工具 ${toolName} 不能访问工作区外的路径：${rawPath}`);
  }

  // 对已经存在的目标跟随符号链接；对新文件则检查最近的现存父目录。
  let existingPath = requestedPath;
  let resolvedPath: string;
  while (true) {
    try {
      resolvedPath = await realpath(existingPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) throw error;
      existingPath = parentPath;
    }
  }

  if (!isPathInside(allowedRoot, resolvedPath)) {
    throw new Error(`工具 ${toolName} 不能通过符号链接访问工作区外的内容：${rawPath}`);
  }

  // find/grep 的 glob 也不能通过 ../ 逃出工作区。
  const glob = toolName === "find"
    ? input.pattern
    : toolName === "grep"
      ? input.glob
      : undefined;
  if (typeof glob === "string") {
    const segments = glob.replace(/\\/g, "/").split("/");
    if (path.isAbsolute(glob) || segments.includes("..")) {
      throw new Error(`工具 ${toolName} 的搜索模式不能越出工作区：${glob}`);
    }
  }
}

/** path.relative 能正确处理路径边界，避免简单字符串前缀误判。 */
function isPathInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function wrapToolWithApproval(
  tool: ToolDefinition<any, any, any>,
  allowedRoot: string,
): ToolDefinition<any, any, any> {
  const execute = tool.execute;

  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const input = params as Record<string, unknown>;
      const isReadOnly = ["read", "find", "grep", "ls"].includes(tool.name);

      // 所有文件类工具只能访问工作区内的路径，且要检查符号链接的真实目标。
      await assertToolPathsInsideWorkspace(tool.name, input, allowedRoot);

      // Explore 下只放行 AST 检查通过的只读 Bash 命令。
      if (tool.name === "bash" && permissionMode === "explore") {
        const command = typeof input.command === "string" ? input.command : "";
        const decision = checkExploreBashCommand(command);
        if (!decision.allowed) throw new Error(decision.reason);
        return execute(toolCallId, params, signal, onUpdate, context);
      }

      // Explore 模式仅允许读取；Ask 模式中读取不打断用户，写入和命令需确认。
      if (permissionMode === "explore" && !isReadOnly) {
        throw new Error(`Explore 模式禁止执行写入或命令工具：${tool.name}`);
      }
      // Execute 模式放行所有工具；只读工具在其他模式下也自动放行。
      if (permissionMode === "execute" || isReadOnly) {
        return execute(toolCallId, params, signal, onUpdate, context);
      }

      const requestId = randomUUID();
      const request = new Promise<boolean>((resolve) => {
        permissionWaiters.set(requestId, resolve);
      });

      if (!activeRequestId) {
        permissionWaiters.delete(requestId);
        throw new Error("当前没有活动请求，工具执行已取消。");
      }

      send({
        type: "permission_request",
        id: activeRequestId,
        requestId,
        toolName: tool.name,
        input,
      });

      const approved = await request;
      if (!approved) throw new Error(`用户拒绝执行工具：${tool.name}`);

      return execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

/** 创建会话目录后，让 Pi 继续使用该目录中最近的会话记录。 */
async function createPersistentSessionManager(cwd: string, directory: string) {
  await mkdir(directory, { recursive: true });
  return SessionManager.continueRecent(cwd, directory);
}

/** 把本轮问题交给 Pi；会话事件由 handleSessionEvent 流式转发。 */
async function runPrompt(requestId: string, message: string): Promise<void> {
  try {
    await session!.prompt(message);
  } catch (error) {
    send({
      type: "event",
      id: requestId,
      event: {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    send({ type: "event", id: requestId, event: { type: "complete" } });
  } finally {
    activeRequestId = null;
  }
}

/** 只把应用当前需要的 Pi 事件转换成统一 AgentEvent。 */
function handleSessionEvent(event: AgentSessionEvent): void {
  const requestId = activeRequestId;
  if (!requestId) return;

  // message_update 中的 text_delta 是模型刚生成的文本片段。
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    send({
      type: "event",
      id: requestId,
      event: {
        type: "text_delta",
        text: event.assistantMessageEvent.delta,
      },
    });
  }

  // 把 Pi SDK 的工具开始事件变成界面可读的产品事件。
  if (event.type === "tool_execution_start") {
    send({
      type: "event",
      id: requestId,
      event: {
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args as Record<string, unknown>,
      },
    });
  }

  // 工具结束时回传文字结果，限制长度以免超大输出撑满聊天界面。
  if (event.type === "tool_execution_end") {
    const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const resultText = result?.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n") || JSON.stringify(event.result) || "工具已完成，但没有可显示的文本结果。";

    send({
      type: "event",
      id: requestId,
      event: {
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: resultText.slice(0, 4000),
        isError: event.isError,
      },
    });
  }

  // 将 SDK 报告的模型错误映射成应用统一错误事件。
  if (
    event.type === "message_end" &&
    event.message.role === "assistant" &&
    event.message.stopReason === "error"
  ) {
    send({
      type: "event",
      id: requestId,
      event: {
        type: "error",
        message: event.message.errorMessage || "Pi 模型请求失败。",
      },
    });
  }

  // agent_end 表示 Pi 已完成本轮模型与工具循环。
  if (event.type === "agent_end") {
    send({ type: "event", id: requestId, event: { type: "complete" } });
  }
}

/** 解除事件订阅、释放 Pi session，然后退出子进程。 */
async function shutdown(): Promise<void> {
  if (isClosing) return;
  isClosing = true;

  // 关闭时解除所有挂起的确认等待，避免工具 Promise 永远悬空。
  for (const resolve of permissionWaiters.values()) resolve(false);
  permissionWaiters.clear();

  unsubscribe?.();
  unsubscribe = null;

  try {
    await session?.dispose();
  } catch (error) {
    process.stderr.write(
      `[Pi server] 释放 session 失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  process.exit(0);
}
