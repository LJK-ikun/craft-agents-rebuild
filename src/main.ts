import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import { createBackend } from "./backend/factory.ts";
import {
  JsonlSessionStore,
  type ConversationMessage,
  type SessionRecord,
} from "./jsonl-store.ts";

import { WorkspaceStore } from "./workspace-store.ts";
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

// 记录当前选中的 Workspace ID。
let activeWorkspaceId: string | null = null;
// 保存当前项目目录，供当前工作区创建模型后端时使用。
let activeWorkingDirectory: string | null = null;
// Agent、存储对象和当前会话 ID 都由主进程管理。
let agent: Agent | null = null;
let sessionStore: JsonlSessionStore | null = null;
let activeSessionId: string | null = null;
// 权限确认可能晚于会话切换；用 requestId 记录原 Agent，避免把决定发错进程。
const permissionOwners = new Map<string, Agent>();

function clearPermissionsForAgent(target: Agent | null): void {
  if (!target) return;
  for (const [requestId, owner] of permissionOwners) {
    if (owner === target) permissionOwners.delete(requestId);
  }
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
async function activateWorkspace(workspaceId: string) {
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
  clearPermissionsForAgent(agent);
  await agent?.dispose();
  activeWorkspaceId = workspace.id;
  activeWorkingDirectory = workspace.workingDirectory;
  activeSessionId = sessionId;
  sessionStore = nextSessionStore;
  agent = createAgent(
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

// 界面请求会话列表，主进程从存储层读取并返回
ipcMain.handle("session:list", async () => {
  if (!sessionStore) throw new Error("会话存储尚未初始化。");
  return sessionStore.listSessions();
});


// 界面请求新建会话时，主进程创建记录并切换到这个空会话。
ipcMain.handle("session:create", async () => {
  if (!sessionStore) throw new Error("会话存储尚未初始化。");
  if (!activeWorkingDirectory) throw new Error("当前工作区尚未初始化。");

  // 在索引里创建会话记录，并取得新会话的唯一 ID。
  const session = await sessionStore.createSession();

  // 关闭旧会话的模型进程，避免切换后仍留在后台。
  clearPermissionsForAgent(agent);
  await agent?.dispose();

  // 更新当前会话 ID，后续发送的问题就会保存到这个会话。
  activeSessionId = session.id;

  // 新会话没有历史消息，因此创建一个空历史的 Agent。
  agent = createAgent(session, activeWorkingDirectory, sessionStore, []);

  // 把新会话资料和空消息列表交还给界面。
  return { session, messages: [] };
});

// 界面选择会话时，主进程读取该会话历史并重建 Agent
ipcMain.handle("session:select", async (_event, sessionId: unknown) => {
  if (!sessionStore) throw new Error("会话存储尚未初始化")
  if (typeof sessionId !== "string") {
    throw new Error("会话 ID 无效")
  }

  const messages = await sessionStore.loadMessages(sessionId)
  const toolActivities = await sessionStore.loadToolActivities(sessionId);
  const sessions = await sessionStore.listSessions();
  const selectedSession = sessions.find((session) => session.id === sessionId);
  if (!selectedSession) throw new Error("找不到指定会话。");
  if (!activeWorkingDirectory) throw new Error("当前工作区尚未初始化。");

  // 关闭旧会话的模型进程，再创建所选会话的 Agent。
  clearPermissionsForAgent(agent);
  await agent?.dispose();

  // 成功读到目标绘画后，再更新当前会话状态
  activeSessionId = sessionId;
  agent = createAgent(
    selectedSession,
    activeWorkingDirectory,
    sessionStore,
    messages,
  )

  return { messages, toolActivities }
})
// 返回所有已登记的工作区，供界面显示工作区列表。
ipcMain.handle("workspace:list", async () => {
  return workspaceStore.list();
});

// 弹出目录选择框，把用户选中的项目文件夹登记成工作区。
ipcMain.handle("workspace:add", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择项目文件夹",
    properties: ["openDirectory"],
  });

  // 用户取消选择时，不创建工作区。
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  // 保存工作区后立即切换过去。
  const workspace = await workspaceStore.addWorkspace(result.filePaths[0]);
  return activateWorkspace(workspace.id);
});

// 切换到界面指定的工作区。
ipcMain.handle("workspace:select", async (_event, workspaceId: unknown) => {
  if (typeof workspaceId !== "string") {
    throw new Error("工作区 ID 无效。");
  }

  return activateWorkspace(workspaceId);
});
// 界面读取当前会话历史时，只返回当前 ID 对应的消息
ipcMain.handle("session:history", async () => {
  if (!sessionStore) throw new Error("会话存储尚未初始化。");
  if (!activeSessionId) throw new Error("当前没有选中的会话。");

  return sessionStore.loadMessages(activeSessionId);
});

// 只有当前确实发出过该权限请求的 Agent，才能收到界面的批准结果。
ipcMain.handle("agent:permission-response", (_event, requestId: unknown, approved: unknown) => {
  if (typeof requestId !== "string" || typeof approved !== "boolean") {
    throw new Error("工具权限响应无效。");
  }
  const owner = permissionOwners.get(requestId);
  if (!owner) throw new Error("该工具请求已失效或已经处理。");

  permissionOwners.delete(requestId);
  owner.respondToPermission?.(requestId, approved);
});

// 保存当前会话的权限模式，并立即同步给当前运行中的 Pi Agent。
ipcMain.handle("session:set-permission-mode", async (_event, mode: unknown) => {
  if (mode !== "explore" && mode !== "ask" && mode !== "execute") {
    throw new Error("权限模式无效。");
  }
  if (!sessionStore || !activeSessionId) throw new Error("当前没有活动会话。");

  await sessionStore.savePermissionMode(activeSessionId, mode);
  agent?.setPermissionMode(mode);
  return mode;
});

// 界面发送问题时，调用当前会话的 Agent，并把问答保存到当前会话。
ipcMain.handle("agent:ask", async (event, userText: unknown): Promise<string> => {
  if (typeof userText !== "string" || !userText.trim()) {
    throw new Error("请输入有效的问题。");
  }
  if (!sessionStore) throw new Error("会话存储尚未初始化。");
  if (!agent) {
    throw new Error(
      "请设置 PI_API_KEY（或 ANTHROPIC_API_KEY）；可选设置 PI_AUTH_PROVIDER 和 PI_MODEL。",
    );
  }
  if (!activeSessionId) throw new Error("当前没有选中的会话。");

  // 先保存本次使用的对象和 ID，避免请求等待期间切换会话后存错地方。
  const currentAgent = agent;
  const currentSessionStore = sessionStore;
  const sessionId = activeSessionId;
  const question = userText.trim();

  const answerParts: string[] = [];

  // 一边读取后端事件，一边发给 Renderer；同时收集文本用于历史存储。
  for await (const agentEvent of currentAgent.chat(question)) {
    if (agentEvent.type === "permission_request") {
      permissionOwners.set(agentEvent.requestId, currentAgent);
    }
    event.sender.send("agent:event", agentEvent);

    // 持久化工具轨迹；若日志写入失败，记录错误但不中断模型本轮执行。
    if (agentEvent.type === "tool_start" || agentEvent.type === "tool_result") {
      try {
        await currentSessionStore.appendToolEvent(sessionId, agentEvent);
      } catch (error) {
        console.error("Failed to persist tool event:", error);
      }
    }

    if (agentEvent.type === "text_delta") {
      answerParts.push(agentEvent.text);
    }

    if (agentEvent.type === "error") {
      throw new Error(agentEvent.message);
    }
  }

  const answer = answerParts.join("");

  // 两条消息都写入刚才发起请求的那个会话。
  await currentSessionStore.appendMessage(sessionId, {
    role: "user",
    content: question,
  });
  await currentSessionStore.appendMessage(sessionId, {
    role: "assistant",
    content: answer,
  });

  return answer;
});

// 创建窗口前先恢复默认会话及历史
async function createMainWindow(): Promise<void> {
  // 工作区注册表保存在 Electron 用户数据目录。
  workspaceStore = new WorkspaceStore(
    path.join(app.getPath("userData"), "workspaces"),
  );

  // 启动时恢复第一个工作区；没有工作区时由界面提示用户添加。
  const workspaces = await workspaceStore.list();
  if (workspaces[0]) {
    await activateWorkspace(workspaces[0].id);
  }

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

  const agentToDispose = agent;
  clearPermissionsForAgent(agentToDispose);
  agent = null;

  const disposePromise = agentToDispose?.dispose() ?? Promise.resolve();
  void disposePromise.catch((error: unknown) => {
    console.error("Failed to dispose the active agent:", error);
  }).finally(() => {
    app.quit();
  });
});
