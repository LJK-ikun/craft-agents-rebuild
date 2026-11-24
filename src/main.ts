import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import { createBackend } from "./backend/factory.ts";
import {
  JsonlSessionStore,
  type ConversationMessage,
  type SessionRecord,
} from "./jsonl-store.ts";

import { WorkspaceStore } from "./workspace-store.ts";
import { CraftRpcServer } from "./transport/rpc-server.ts";
import type { RpcBootstrap } from "./transport/rpc-types.ts";
import type { AgentProvider, BackendConfig } from "./types.ts";

// 从 Electron 导入应用生命周期、窗口、目录选择框和 IPC 注册工具。
import { app, BrowserWindow, dialog, ipcMain } from "electron";
// ESM 文件没有内置 __dirname：从当前文件地址得到它所在目录
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

// 默认用 Pi SDK 管理 Agent；底层模型服务商可通过环境变量选择。
const backendProvider: AgentProvider = "pi";
const piAuthProvider = process.env.PI_AUTH_PROVIDER || "anthropic";
const apiKey = process.env.PI_API_KEY || process.env.ANTHROPIC_API_KEY;
const modelName =
  process.env.PI_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  "claude-sonnet-4-6";
const systemPrompt = "你是一个简洁、准确的中文助手。";

// 管理所有 Workspace 的注册信息。
let workspaceStore!: WorkspaceStore;
// 本地 WebSocket-RPC 服务由 Electron 主进程承载，Preload 只拿到连接信息。
let rpcServer: CraftRpcServer | null = null;
let rpcBootstrap: RpcBootstrap | null = null;

// Preload 只通过这个启动频道获取 RPC 地址和令牌，不开放任意 IPC 调用能力。
ipcMain.on("rpc:bootstrap", (event) => {
  event.returnValue = rpcBootstrap;
});

// 每个 WebSocket 客户端拥有独立的当前工作区、会话和 Agent 运行状态。
type ClientRuntime = {
  activeWorkspaceId: string | null;
  activeWorkingDirectory: string | null;
  agent: Agent | null;
  sessionStore: JsonlSessionStore | null;
  activeSessionId: string | null;
  activeAsk: { id: string; agent: Agent } | null;
};

const clientRuntimes = new Map<string, ClientRuntime>();
// 每个确认请求记录发起它的 Agent 和客户端，避免其他客户端代为批准。
const permissionOwners = new Map<string, { agent: Agent; clientId: string }>();

function getClientRuntime(clientId: string): ClientRuntime {
  let runtime = clientRuntimes.get(clientId);
  if (!runtime) {
    runtime = {
      activeWorkspaceId: null,
      activeWorkingDirectory: null,
      agent: null,
      sessionStore: null,
      activeSessionId: null,
      activeAsk: null,
    };
    clientRuntimes.set(clientId, runtime);
  }
  return runtime;
}

function clearPermissionsForAgent(target: Agent | null): void {
  if (!target) return;
  for (const [requestId, owner] of permissionOwners) {
    if (owner.agent === target) permissionOwners.delete(requestId);
  }
}

async function disposeClientRuntime(clientId: string): Promise<void> {
  const runtime = clientRuntimes.get(clientId);
  if (!runtime) return;
  clearPermissionsForAgent(runtime.agent);
  clientRuntimes.delete(clientId);
  await runtime.agent?.dispose();
}

// 为一个应用会话创建 Agent，并把 Pi SDK 数据隔离到该会话的目录。
function createAgent(
  session: SessionRecord,
  workingDirectory: string,
  currentSessionStore: JsonlSessionStore,
  messages: ConversationMessage[],
): Agent | null {
  if (!apiKey || !modelName) return null;

  const config: BackendConfig = {
    provider: backendProvider,
    model: modelName,
    piAuthProvider,
    permissionMode: session.permissionMode ?? "ask",
    piSessionDirectory: path.join(
      currentSessionStore.getSessionDirectory(session.id),
      ".pi-sessions",
    ),
    // MCP 配置属于工作区，不混入会话历史；文件不存在时 Agent 继续使用内置工具。
    mcpConfigPath: path.join(workingDirectory, ".craft", "mcp.json"),
    apiKey,
    workingDirectory,
    systemPrompt,
    sdkSessionId: session.sdkSessionId,
    initialHistory: messages,
    onSdkSessionId: (sdkSessionId) =>
      currentSessionStore.saveSdkSessionId(session.id, sdkSessionId),
  };

  return new Agent(createBackend(config, currentDirectory));
}

// 切换到指定工作区，并加载它自己的会话和聊天历史。
async function activateWorkspace(workspaceId: string, runtime: ClientRuntime) {
  // 从工作区列表里找到目标工作区。
  const workspaces = await workspaceStore.list();
  const workspace = workspaces.find((item) => item.id === workspaceId);

  if (!workspace) {
    throw new Error("找不到指定工作区。");
  }

  // 每个工作区都使用自己的 sessions 目录，因此会话不会串在一起。
  const nextSessionStore = new JsonlSessionStore(
    path.join(workspace.rootPath, "sessions"),
  );

  // 读取这个工作区的会话列表；首次使用时会创建默认会话。
  const sessions = await nextSessionStore.listSessions();
  const activeSession = sessions[0];
  const sessionId = activeSession.id;

  // 读取默认会话的消息，并用它们创建 Agent。
  const messages = await nextSessionStore.loadMessages(sessionId);
  const toolActivities = await nextSessionStore.loadToolActivities(sessionId);

  // 确认数据读取成功后，再把当前状态切换到目标工作区。
  clearPermissionsForAgent(runtime.agent);
  await runtime.agent?.dispose();
  runtime.activeWorkspaceId = workspace.id;
  runtime.activeWorkingDirectory = workspace.workingDirectory;
  runtime.activeSessionId = sessionId;
  runtime.sessionStore = nextSessionStore;
  runtime.agent = createAgent(
    activeSession,
    workspace.workingDirectory,
    nextSessionStore,
    messages,
  );

  // 把界面需要展示的数据返回给调用方。
  return {
    workspace,
    sessions,
    activeSessionId: sessionId,
    messages,
    toolActivities,
  };
}

// 把应用业务能力注册到 WebSocket-RPC；Renderer 只能调用这里明确开放的频道。
function registerRpcHandlers(server: CraftRpcServer): void {
  // 读取本客户端当前工作区中的会话列表，不会读到别的客户端选择状态。
  server.handle("session:list", async (context) => {
    const store = getClientRuntime(context.clientId).sessionStore;
    if (!store) throw new Error("请先选择工作区。");
    return store.listSessions();
  });

  // 创建会话时只替换当前客户端的 Agent，不影响其他窗口正在使用的 Agent。
  server.handle("session:create", async (context) => {
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.sessionStore || !runtime.activeWorkingDirectory) {
      throw new Error("请先选择工作区。");
    }
    const session = await runtime.sessionStore.createSession();
    clearPermissionsForAgent(runtime.agent);
    await runtime.agent?.dispose();
    runtime.activeSessionId = session.id;
    runtime.agent = createAgent(session, runtime.activeWorkingDirectory, runtime.sessionStore, []);
    return { session, messages: [] };
  });

  // 会话切换会读取对应历史，并为当前客户端重建 Agent。
  server.handle("session:select", async (context, sessionId: unknown) => {
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.sessionStore || !runtime.activeWorkingDirectory) throw new Error("请先选择工作区。");
    if (typeof sessionId !== "string") throw new Error("会话 ID 无效。");

    const sessions = await runtime.sessionStore.listSessions();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("找不到指定会话。");
    const messages = await runtime.sessionStore.loadMessages(sessionId);
    const toolActivities = await runtime.sessionStore.loadToolActivities(sessionId);

    clearPermissionsForAgent(runtime.agent);
    await runtime.agent?.dispose();
    runtime.activeSessionId = sessionId;
    runtime.agent = createAgent(session, runtime.activeWorkingDirectory, runtime.sessionStore, messages);
    return { messages, toolActivities };
  });

  server.handle("workspace:list", async () => workspaceStore.list());

  // 工作区目录选择是 Electron 原生能力，因此 RPC 请求仍由主进程执行。
  server.handle("workspace:add", async (context) => {
    const result = await dialog.showOpenDialog({
      title: "选择项目文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const workspace = await workspaceStore.addWorkspace(result.filePaths[0]);
    return activateWorkspace(workspace.id, getClientRuntime(context.clientId));
  });

  // 选择工作区后只更新发起该 RPC 请求的客户端状态。
  server.handle("workspace:select", async (context, workspaceId: unknown) => {
    if (typeof workspaceId !== "string") throw new Error("工作区 ID 无效。");
    return activateWorkspace(workspaceId, getClientRuntime(context.clientId));
  });

  server.handle("session:history", async (context) => {
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.sessionStore || !runtime.activeSessionId) throw new Error("当前没有选中的会话。");
    return runtime.sessionStore.loadMessages(runtime.activeSessionId);
  });

  // 工具批准必须由发起该工具请求的同一客户端提交。
  server.handle("agent:permission-response", (context, requestId: unknown, approved: unknown) => {
    if (typeof requestId !== "string" || typeof approved !== "boolean") throw new Error("工具权限响应无效。");
    const owner = permissionOwners.get(requestId);
    if (!owner) throw new Error("该工具请求已失效或已经处理。");
    if (owner.clientId !== context.clientId) throw new Error("无权响应其他窗口的工具请求。");
    permissionOwners.delete(requestId);
    owner.agent.respondToPermission(requestId, approved);
  });

  // 权限模式保存在该客户端当前选中的会话，并同步给它的 Agent。
  server.handle("session:set-permission-mode", async (context, mode: unknown) => {
    if (mode !== "explore" && mode !== "ask" && mode !== "execute") throw new Error("权限模式无效。");
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.sessionStore || !runtime.activeSessionId) throw new Error("当前没有活动会话。");
    await runtime.sessionStore.savePermissionMode(runtime.activeSessionId, mode);
    runtime.agent?.setPermissionMode(mode);
    return mode;
  });

  // 取消只作用于当前客户端自己的运行请求。
  server.handle("agent:cancel", async (context) => {
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.activeAsk) return false;
    await runtime.activeAsk.agent.cancel();
    return true;
  });

  // 运行当前客户端 Agent；事件只推送回这条请求的来源连接。
  server.handle("agent:ask", async (context, userText: unknown): Promise<string> => {
    if (typeof userText !== "string" || !userText.trim()) throw new Error("请输入有效的问题。");
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.sessionStore || !runtime.activeSessionId) throw new Error("请先选择工作区和会话。");
    if (!runtime.agent) {
      throw new Error("请设置 PI_API_KEY（或 ANTHROPIC_API_KEY）；可选设置 PI_AUTH_PROVIDER 和 PI_MODEL。");
    }
    if (runtime.activeAsk) throw new Error("当前客户端已有一条 Agent 请求正在运行。");

    const currentAgent = runtime.agent;
    const currentStore = runtime.sessionStore;
    const sessionId = runtime.activeSessionId;
    const askId = randomUUID();
    const question = userText.trim();
    runtime.activeAsk = { id: askId, agent: currentAgent };
    const answerParts: string[] = [];

    try {
      for await (const event of currentAgent.chat(question)) {
        if (event.type === "permission_request") {
          permissionOwners.set(event.requestId, { agent: currentAgent, clientId: context.clientId });
        }
        if (event.type === "cancelled") clearPermissionsForAgent(currentAgent);
        server.pushToClient(context.clientId, "agent:event", event);

        if (event.type === "tool_start" || event.type === "tool_result") {
          try {
            await currentStore.appendToolEvent(sessionId, event);
          } catch (error) {
            console.error("Failed to persist tool event:", error);
          }
        }
        if (event.type === "text_delta") answerParts.push(event.text);
        if (event.type === "error") throw new Error(event.message);
      }
    } finally {
      if (runtime.activeAsk?.id === askId) runtime.activeAsk = null;
    }

    const answer = answerParts.join("");
    await currentStore.appendMessage(sessionId, { role: "user", content: question });
    await currentStore.appendMessage(sessionId, { role: "assistant", content: answer });
    return answer;
  });
}

// 创建窗口前先恢复默认会话及历史
async function createMainWindow(): Promise<void> {
  // 工作区注册表保存在 Electron 用户数据目录。
  workspaceStore = new WorkspaceStore(
    path.join(app.getPath("userData"), "workspaces"),
  );

  // 建立 WebSocket-RPC 服务，并注册所有工作区、会话和 Agent 业务频道。
  rpcServer = new CraftRpcServer();
  registerRpcHandlers(rpcServer);
  rpcServer.onClientDisconnected((clientId) => {
    void disposeClientRuntime(clientId).catch((error: unknown) => {
      console.error("Failed to dispose disconnected RPC client:", error);
    });
  });
  rpcBootstrap = await rpcServer.listen();

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发时加载 Vite 开发服务器；打包后加载本地构建出的页面。
  if (app.isPackaged) {
    void window.loadFile(path.join(currentDirectory, "renderer", "index.html"));
  } else {
    void window.loadURL("http://127.0.0.1:5173");
  }
}

// Electron 初始化完成后创建窗口，并记录初始化失败的具体原因。
void app.whenReady().then(createMainWindow).catch((error: unknown) => {
  console.error("Failed to initialize the application:", error);
  app.quit();
});

// macOS 通常在关闭最后一个窗口后保留应用；其他平台则退出应用。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 先等待 Agent 子进程关闭，再让 Electron 正常退出。
let isQuitting = false;
app.on("before-quit", (event) => {
  if (isQuitting) return;

  isQuitting = true;
  event.preventDefault();

  const disposePromises = [...clientRuntimes.keys()].map(disposeClientRuntime);
  const closeRpcPromise = rpcServer?.close() ?? Promise.resolve();
  void Promise.all([...disposePromises, closeRpcPromise]).catch((error: unknown) => {
    console.error("Failed to shut down the application cleanly:", error);
  }).finally(() => {
    app.quit();
  });
});
