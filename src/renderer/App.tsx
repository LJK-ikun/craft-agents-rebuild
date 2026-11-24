import { useEffect, useState, type FormEvent } from "react";
import type { ToolActivity } from "../types.ts";

// 一条聊天消息由说话人和文字内容组成。
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// 会话列表显示的基本信息。
type Session = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  permissionMode?: "explore" | "ask" | "execute";
};

// Workspace 列表显示的基本信息。
type Workspace = {
  id: string;
  name: string;
  rootPath: string;
  workingDirectory: string;
  createdAt: string;
};

// 主进程切换 Workspace 后返回的界面数据。
type WorkspaceState = {
  workspace: Workspace;
  sessions: Session[];
  activeSessionId: string;
  messages: ChatMessage[];
  toolActivities: ToolActivity[];
};

// 等待用户批准的工具请求：工具名和参数都来自本地 Agent 运行时。
type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export function App() {
  // 保存所有工作区，以及当前选中的工作区和会话。
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // 保存当前会话的消息和输入框内容。
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequest[]>([]);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [permissionMode, setPermissionMode] = useState<"explore" | "ask" | "execute">("ask");

  // 保存错误和界面操作状态，避免加载或请求时重复操作。
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // 订阅主进程转发来的文本片段，并实时追加到最后一条助手消息。
  useEffect(() => {
    return window.craftAgent.onAgentEvent((event) => {
      if (event.type === "permission_request") {
        setPermissionRequests((current) => [
          ...current.filter((item) => item.requestId !== event.requestId),
          event,
        ]);
        return;
      }
      if (event.type === "tool_start") {
        setToolActivities((current) => [
          ...current.filter((item) => item.toolCallId !== event.toolCallId),
          { ...event },
        ]);
        return;
      }
      if (event.type === "tool_result") {
        setToolActivities((current) => current.map((item) =>
          item.toolCallId === event.toolCallId
            ? { ...item, result: event.result, isError: event.isError }
            : item,
        ));
        return;
      }
      if (event.type !== "text_delta") return;

      setMessages((current) => {
        const lastMessage = current[current.length - 1];
        if (lastMessage?.role === "assistant") {
          return [
            ...current.slice(0, -1),
            { ...lastMessage, content: lastMessage.content + event.text },
          ];
        }

        return [...current, { role: "assistant", content: event.text }];
      });
    });
  }, []);

  // 用户明确选择允许或拒绝后，主进程会把决定送回 Pi 子进程。
  async function handlePermission(requestId: string, approved: boolean) {
    try {
      await window.craftAgent.respondToPermission(requestId, approved);
      setPermissionRequests((current) => current.filter((item) => item.requestId !== requestId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 界面首次打开时，读取 Workspace 列表并恢复第一个工作区。
  useEffect(() => {
    let cancelled = false;

    async function loadWorkspaces() {
      try {
        const savedWorkspaces = await window.craftAgent.listWorkspaces();
        if (cancelled) return;

        setWorkspaces(savedWorkspaces);

        // 首次使用时可能还没有工作区，界面会显示添加入口。
        const firstWorkspace = savedWorkspaces[0];
        if (!firstWorkspace) return;

        // 主进程会返回该工作区的会话列表、当前会话和消息历史。
        const state = await window.craftAgent.selectWorkspace(firstWorkspace.id);
        if (cancelled) return;

        applyWorkspaceState(state);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadWorkspaces();

    // 组件卸载后，忽略尚未完成的加载结果。
    return () => {
      cancelled = true;
    };
  }, []);

  // 把主进程返回的工作区状态同步到界面各个状态变量。
  function applyWorkspaceState(state: WorkspaceState) {
    setActiveWorkspaceId(state.workspace.id);
    setSessions(state.sessions);
    setActiveSessionId(state.activeSessionId);
    setMessages(state.messages);
    setToolActivities(state.toolActivities);
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
    setPermissionMode(activeSession?.permissionMode ?? "ask");
    setPermissionRequests([]);
    setQuestion("");
  }

  // 弹出文件夹选择框，创建 Workspace 并切换过去。
  async function handleAddWorkspace() {
    if (busy || loading) return;

    setBusy(true);
    setError("");

    try {
      const state = await window.craftAgent.addWorkspace();

      // 用户取消文件夹选择时，主进程返回 null，不改变界面状态。
      if (!state) return;

      // 将新工作区放到列表最前面，并去掉可能已有的同 ID 记录。
      setWorkspaces((current) => [
        state.workspace,
        ...current.filter((item) => item.id !== state.workspace.id),
      ]);

      // 新工作区成为当前工作区，显示它自己的会话和消息。
      applyWorkspaceState(state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // 切换工作区，并用主进程返回的数据替换当前会话状态。
  async function handleSelectWorkspace(workspaceId: string) {
    if (busy || loading || workspaceId === activeWorkspaceId) return;

    setBusy(true);
    setError("");

    try {
      const state = await window.craftAgent.selectWorkspace(workspaceId);
      applyWorkspaceState(state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // 在当前工作区创建一个新会话。
  async function handleCreateSession() {
    if (busy || loading || !activeWorkspaceId) return;

    setBusy(true);
    setError("");

    try {
      const result = await window.craftAgent.createSession();

      // 新会话放到列表最前面，并将它设为当前会话。
      setSessions((current) => [result.session, ...current]);
      setActiveSessionId(result.session.id);
      setMessages(result.messages);
      setToolActivities([]);
      setPermissionMode(result.session.permissionMode ?? "ask");
      setPermissionRequests([]);
      setQuestion("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // 切换到当前工作区里的另一个会话。
  async function handleSelectSession(sessionId: string) {
    if (busy || loading || sessionId === activeSessionId) return;

    setBusy(true);
    setError("");

    try {
      const history = await window.craftAgent.selectSession(sessionId);
      setActiveSessionId(sessionId);
      setMessages(history.messages);
      setToolActivities(history.toolActivities);
      setPermissionMode(sessions.find((session) => session.id === sessionId)?.permissionMode ?? "ask");
      setPermissionRequests([]);
      setQuestion("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // 改变权限模式时由主进程校验并保存，切换后端行为也同步生效。
  async function handlePermissionModeChange(mode: "explore" | "ask" | "execute") {
    try {
      await window.craftAgent.setPermissionMode(mode);
      setPermissionMode(mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 把问题发给当前会话对应的 Agent。
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = question.trim();
    if (!text || busy || loading || !activeSessionId) return;

    setBusy(true);
    setError("");
    setToolActivities([]);
    setMessages((current) => [
      ...current,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);

    try {
      const answer = await window.craftAgent.ask(text);

      // 用 IPC 最终返回值校准界面中的完整答案。
      setMessages((current) => {
        const lastMessage = current[current.length - 1];
        if (lastMessage?.role === "assistant") {
          return [
            ...current.slice(0, -1),
            { ...lastMessage, content: answer },
          ];
        }
        return [...current, { role: "assistant", content: answer }];
      });
      setQuestion("");
    } catch (cause) {
      // 请求失败时移除尚未收到正文的空白回答占位。
      setMessages((current) => {
        const lastMessage = current[current.length - 1];
        return lastMessage?.role === "assistant" && !lastMessage.content
          ? current.slice(0, -1)
          : current;
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ display: "flex", gap: 24, margin: "32px auto", maxWidth: 1100, padding: 24 }}>
      <aside style={{ minWidth: 220 }}>
        <h2>工作区</h2>

        <button disabled={busy || loading} onClick={() => void handleAddWorkspace()} type="button">
          添加工作区
        </button>

        {workspaces.map((workspace) => (
          <button
            aria-pressed={workspace.id === activeWorkspaceId}
            disabled={busy || loading}
            key={workspace.id}
            onClick={() => void handleSelectWorkspace(workspace.id)}
            style={{ display: "block", marginTop: 8 }}
            type="button"
          >
            {workspace.name}
          </button>
        ))}

        <h2>会话</h2>

        <button
          disabled={busy || loading || !activeWorkspaceId}
          onClick={() => void handleCreateSession()}
          type="button"
        >
          新建会话
        </button>

        {sessions.map((session) => (
          <button
            aria-pressed={session.id === activeSessionId}
            disabled={busy || loading}
            key={session.id}
            onClick={() => void handleSelectSession(session.id)}
            style={{ display: "block", marginTop: 8 }}
            type="button"
          >
            {session.title}
          </button>
        ))}
      </aside>

      <section style={{ flex: 1 }}>
        <h1>Craft Agents Learning Rebuild</h1>

        <label>
          工具权限：
          <select
            onChange={(event) => void handlePermissionModeChange(event.target.value as "explore" | "ask" | "execute")}
            value={permissionMode}
          >
            <option value="explore">探索：只读</option>
            <option value="ask">询问：写入/命令前确认</option>
            <option value="execute">执行：自动放行</option>
          </select>
        </label>

        {loading && <p>正在加载工作区…</p>}
        {!loading && workspaces.length === 0 && (
          <p>还没有工作区。点击“添加工作区”选择一个项目文件夹。</p>
        )}

        <section aria-label="聊天记录" aria-live="polite">
          {toolActivities.map((activity) => (
            <article key={activity.toolCallId} style={{ borderLeft: "3px solid #888", margin: "12px 0", paddingLeft: 12 }}>
              <strong>工具：{activity.toolName}</strong>
              <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>
                {JSON.stringify(activity.input, null, 2)}
              </pre>
              {activity.result !== undefined && (
                <details open={activity.isError}>
                  <summary>{activity.isError ? "执行失败" : "执行结果"}</summary>
                  <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>{activity.result}</pre>
                </details>
              )}
            </article>
          ))}
          {messages.map((message, index) => (
            <article key={`${index}-${message.role}`}>
              <strong>{message.role === "user" ? "你" : "助手"}</strong>
              <p>{message.content}</p>
            </article>
          ))}
        </section>

        {permissionRequests.map((request) => (
          <aside
            aria-label="工具执行确认"
            key={request.requestId}
            role="alertdialog"
            style={{ border: "1px solid #c98b22", margin: "16px 0", padding: 16 }}
          >
            <h2>Agent 请求执行工具：{request.toolName}</h2>
            <p>确认后，工具会在当前工作区中执行下面的操作：</p>
            <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(request.input, null, 2)}
            </pre>
            <button onClick={() => void handlePermission(request.requestId, true)} type="button">
              允许执行
            </button>
            <button onClick={() => void handlePermission(request.requestId, false)} type="button">
              拒绝
            </button>
          </aside>
        ))}

        <form onSubmit={handleSubmit}>
          <textarea
            aria-label="输入问题"
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="输入一个问题"
            rows={4}
            value={question}
          />
          <button
            disabled={busy || loading || !question.trim() || !activeSessionId}
            type="submit"
          >
            {busy ? "处理中…" : "发送"}
          </button>
        </form>

        {error && <p role="alert">错误：{error}</p>}
      </section>
    </main>
  );
}
