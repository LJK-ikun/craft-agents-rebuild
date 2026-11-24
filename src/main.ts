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
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
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
const clientCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Preload 只通过这个启动频道获取 RPC 地址和令牌，不开放任意 IPC 调用能力。
ipcMain.on("rpc:bootstrap", (event) => {
  if (!rpcBootstrap) {
    event.returnValue = null;
    return;
  }

  // WebContents ID 用于服务端校验重连是否来自原窗口；clientId 由 RPC 服务端分配。
  event.returnValue = { ...rpcBootstrap, webContentsId: event.sender.id };
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
// 同一个持久化会话同一时刻只允许一个客户端运行，防止共享 Pi 会话目录被并发写入。
const sessionAskOwners = new Map<string, string>();
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
async function activateWorkspace(
  workspaceId: string,
  runtime: ClientRuntime,
  preferredSessionId?: string,
) {
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
  const activeSession = sessions.find((session) => session.id === preferredSessionId) ?? sessions[0];
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
    sources: await workspaceStore.listResources(workspace.id, "source"),
    skills: await workspaceStore.listResources(workspace.id, "skill"),
    statusConfig: await workspaceStore.getStatusConfig(workspace.id),
  };
}

// 断线事件过期时重载界面数据；若仍是同一会话，保留正在运行的 Agent。
async function restoreWorkspaceState(
  workspaceId: string,
  sessionId: string,
  runtime: ClientRuntime,
) {
  if (
    runtime.activeWorkspaceId === workspaceId &&
    runtime.activeSessionId === sessionId &&
    runtime.sessionStore
  ) {
    const workspaces = await workspaceStore.list();
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const sessions = await runtime.sessionStore.listSessions();
    if (workspace && sessions.some((item) => item.id === sessionId)) {
      return {
        workspace,
        sessions,
        activeSessionId: sessionId,
        messages: await runtime.sessionStore.loadMessages(sessionId),
        toolActivities: await runtime.sessionStore.loadToolActivities(sessionId),
        sources: await workspaceStore.listResources(workspaceId, "source"),
        skills: await workspaceStore.listResources(workspaceId, "skill"),
        statusConfig: await workspaceStore.getStatusConfig(workspaceId),
      };
    }
  }

  return activateWorkspace(workspaceId, runtime, sessionId);
}

// 把应用业务能力注册到 WebSocket-RPC；Renderer 只能调用这里明确开放的频道。
function registerRpcHandlers(server: CraftRpcServer): void {
  // 读取本客户端当前工作区中的会话列表，不会读到别的客户端选择状态。
  server.handle("session:list", async (context) => {
    const store = getClientRuntime(context.clientId).sessionStore;
    if (!store) throw new Error("请先选择工作区。");
    return store.listSessions();
  });

  // 更新 Inbox 工作流状态；只接受原版默认状态集合中的值。
  server.handle("session:set-status", async (context, sessionId: unknown, status: unknown) => {
    const runtime = getClientRuntime(context.clientId);
    const store = runtime.sessionStore;
    if (!store || !runtime.activeWorkspaceId) throw new Error("请先选择工作区。");
    if (typeof sessionId !== "string") throw new Error("会话 ID 无效。");
    const statusConfig = await workspaceStore.getStatusConfig(runtime.activeWorkspaceId);
    if (typeof status !== "string" || !statusConfig.statuses.some((item) => item.id === status)) {
      throw new Error("会话状态无效。");
    }
    return store.saveStatus(sessionId, status);
  });

  // 更新会话 Flag 标记；主进程检查类型后才修改持久化记录。
  server.handle("session:set-flag", async (context, sessionId: unknown, isFlagged: unknown) => {
    const store = getClientRuntime(context.clientId).sessionStore;
    if (!store) throw new Error("请先选择工作区。");
    if (typeof sessionId !== "string" || typeof isFlagged !== "boolean") {
      throw new Error("会话标记参数无效。");
    }
    return store.saveFlag(sessionId, isFlagged);
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

  // 文件选择框由主进程持有；Renderer 只指定导入成知识文件还是 Skill。
  server.handle("workspace:add-resource", async (context, kind: unknown) => {
    if (kind !== "source" && kind !== "skill") throw new Error("资源类型无效。");
    const runtime = getClientRuntime(context.clientId);
    if (!runtime.activeWorkspaceId) throw new Error("请先选择工作区。");

    const result = await dialog.showOpenDialog({
      title: kind === "skill" ? "导入 Skill Markdown" : "导入知识文件",
      properties: ["openFile", "multiSelections"],
      filters: [{
        name: kind === "skill" ? "Markdown" : "Markdown 与文本",
        extensions: kind === "skill" ? ["md"] : ["md", "txt"],
      }],
    });
    if (result.canceled) return workspaceStore.listResources(runtime.activeWorkspaceId, kind);

    for (const sourcePath of result.filePaths) {
      await workspaceStore.addResource(runtime.activeWorkspaceId, kind, sourcePath);
    }
    return workspaceStore.listResources(runtime.activeWorkspaceId, kind);
  });

  // 选择工作区后只更新发起该 RPC 请求的客户端状态。
  server.handle("workspace:select", async (context, workspaceId: unknown) => {
    if (typeof workspaceId !== "string") throw new Error("工作区 ID 无效。");
    return activateWorkspace(workspaceId, getClientRuntime(context.clientId));
  });

  // 事件缓存过期后，Renderer 把最近使用的工作区和会话传回来重新装载状态。
  server.handle("workspace:restore", async (context, workspaceId: unknown, sessionId: unknown) => {
    if (typeof workspaceId !== "string" || typeof sessionId !== "string") {
      throw new Error("恢复工作区状态所需的 ID 无效。");
    }
    return restoreWorkspaceState(workspaceId, sessionId, getClientRuntime(context.clientId));
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
    const sessionKey = `${runtime.activeWorkspaceId}:${runtime.activeSessionId}`;
    if (sessionAskOwners.has(sessionKey)) {
      throw new Error("这个会话正在另一个窗口运行，请切换到其他会话后再提问。");
    }

    const currentAgent = runtime.agent;
    const currentStore = runtime.sessionStore;
    const sessionId = runtime.activeSessionId;
    const askId = randomUUID();
    const question = userText.trim();
    sessionAskOwners.set(sessionKey, context.clientId);
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

      // 把本轮问答写完后才释放会话锁，防止另一个窗口抢在保存前启动。
      const answer = answerParts.join("");
      await currentStore.appendMessage(sessionId, { role: "user", content: question });
      await currentStore.appendMessage(sessionId, { role: "assistant", content: answer });
      return answer;
    } finally {
      if (runtime.activeAsk?.id === askId) runtime.activeAsk = null;
      if (sessionAskOwners.get(sessionKey) === context.clientId) sessionAskOwners.delete(sessionKey);
    }
  });
}

// 为每个 Renderer 创建一个独立窗口；Preload 会建立自己的 RPC 客户端连接。
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    void window.loadFile(path.join(currentDirectory, "renderer", "index.html"));
  } else {
    void window.loadURL("http://127.0.0.1:5173");
  }
  return window;
}

// 初始化共享 RPC 服务后创建第一个窗口；后续窗口复用该服务，各自拥有客户端状态。
async function initializeApplication(): Promise<void> {
  // 工作区注册表保存在 Electron 用户数据目录。
  workspaceStore = new WorkspaceStore(
    path.join(app.getPath("userData"), "workspaces"),
  );

  // 建立 WebSocket-RPC 服务，并注册所有工作区、会话和 Agent 业务频道。
  rpcServer = new CraftRpcServer();
  registerRpcHandlers(rpcServer);
  rpcServer.onClientDisconnected((clientId) => {
    // 短暂断线先保留状态，给客户端自动重连机会；超时后再清理 Agent。
    const previousTimer = clientCleanupTimers.get(clientId);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      clientCleanupTimers.delete(clientId);
      void disposeClientRuntime(clientId).catch((error: unknown) => {
        console.error("Failed to dispose disconnected RPC client:", error);
      });
    }, 60_000);
    clientCleanupTimers.set(clientId, timer);
  });
  rpcServer.onClientConnected((clientId) => {
    const timer = clientCleanupTimers.get(clientId);
    if (timer) clearTimeout(timer);
    clientCleanupTimers.delete(clientId);
  });
  rpcBootstrap = await rpcServer.listen();

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "新建窗口", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
  ]));

  createWindow();
}

// Electron 初始化完成后创建窗口，并记录初始化失败的具体原因。
void app.whenReady().then(initializeApplication).catch((error: unknown) => {
  console.error("Failed to initialize the application:", error);
  app.quit();
});

// macOS 通常在关闭最后一个窗口后保留应用；其他平台则退出应用。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS 在窗口全部关闭后仍保留应用；用户从 Dock 激活时重新创建一个窗口。
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 先等待 Agent 子进程关闭，再让 Electron 正常退出。
let isQuitting = false;
app.on("before-quit", (event) => {
  if (isQuitting) return;

  isQuitting = true;
  event.preventDefault();

  const disposePromises = [...clientRuntimes.keys()].map(disposeClientRuntime);
  for (const timer of clientCleanupTimers.values()) clearTimeout(timer);
  clientCleanupTimers.clear();
  const closeRpcPromise = rpcServer?.close() ?? Promise.resolve();
  void Promise.all([...disposePromises, closeRpcPromise]).catch((error: unknown) => {
    console.error("Failed to shut down the application cleanly:", error);
  }).finally(() => {
    app.quit();
  });
});
