// appendFile：把新消息追加到文件末尾，不覆盖已有消息。
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

// path：安全地拼接当前操作系统认可的文件路径。
import path from "node:path";

// randomUUID：为新会话生成不重复的 ID。
import { randomUUID } from "node:crypto";
import type { AgentEvent, ToolActivity } from "./types.ts";

// 描述一条聊天消息的数据结构。
// role 表示说话人；content 表示这条消息的文字。
export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

// 状态 ID 来自工作区配置，因此可以是原版内置项，也可以是用户自定义项。
export type SessionStatus = string;

// 描述会话列表里的一项。
// 会话列表只存基本信息，具体聊天消息单独存在 JSONL 文件中。
export type SessionRecord = {
  id: string; // 会话的唯一 ID，用来找到它对应的消息文件。
  title: string; // 会话标题，显示在界面的会话列表中。
  createdAt: string; // 会话创建时间，使用 ISO 时间格式。
  updatedAt: string; // 最近一次保存消息的时间。
  sdkSessionId?: string; // Claude SDK 的会话 ID，用来在下次提问时恢复上下文。
  permissionMode?: "explore" | "ask" | "execute"; // 该会话的工具执行权限模式。
  sessionStatus?: SessionStatus; // 工作区配置中的状态 ID，例如 todo 或 needs-review。
  isFlagged?: boolean; // 是否被标记为重点会话。
};

// 负责管理所有会话的本地文件。
// rootDirectory 是会话数据的根文件夹，例如 Electron 的 userData/sessions。
export class JsonlSessionStore {
  // 保存会话文件夹的位置，后面所有文件路径都从这里开始拼接。
  constructor(private readonly rootDirectory: string) {}

  // 会话列表文件的路径，例如 userData/sessions/index.json。
  // getter 会在每次读取 indexPath 时计算这个路径。
  private get indexPath(): string {
    return path.join(this.rootDirectory, "index.json");
  }

  // 根据会话 ID 得到该会话消息文件的路径。
  // 例如 ID 是 "default"，路径会是 sessions/default/session.jsonl。
  private getSessionFilePath(sessionId: string): string {
    return path.join(this.rootDirectory, sessionId, "session.jsonl");
  }

  // 工具轨迹独立于聊天消息保存，避免把 tool 事件伪装成 user/assistant 消息。
  private getToolEventsFilePath(sessionId: string): string {
    return path.join(this.rootDirectory, sessionId, "tool-events.jsonl");
  }

  // 返回会话自己的目录，供 Pi SDK 在其中保存该会话的运行记录。
  getSessionDirectory(sessionId: string): string {
    return path.join(this.rootDirectory, sessionId);
  }

  // 读取所有会话的基本信息。
  // 如果应用第一次运行、还没有 index.json，就创建一个默认会话。
  async listSessions(): Promise<SessionRecord[]> {
    // 确保会话根文件夹存在；recursive 允许一次创建多层文件夹。
    await mkdir(this.rootDirectory, { recursive: true });

    try {
      // 读取 index.json 的文字内容。
      const text = await readFile(this.indexPath, "utf8");

      // 把 JSON 文字解析成会话记录数组并返回。
      const storedSessions = JSON.parse(text) as Array<SessionRecord & { status?: string }>;
      let migrated = false;
      const sessions = storedSessions.map((session) => {
        // fe29323 曾写入 status 和下划线 ID；这里迁移到原版的 sessionStatus 字段。
        const oldStatus = session.status;
        const legacyIdMap: Record<string, string> = {
          in_progress: "in-progress",
          needs_review: "needs-review",
        };
        const sessionStatus = session.sessionStatus ?? (oldStatus ? legacyIdMap[oldStatus] ?? oldStatus : "todo");
        const { status: _oldStatus, ...currentSession } = session;
        if (_oldStatus !== undefined || session.sessionStatus === undefined) migrated = true;
        return { ...currentSession, sessionStatus };
      });

      // 兼容迁移只写会话索引，不修改消息 JSONL 或 Pi SDK 会话记录。
      if (migrated) await this.saveSessions(sessions);
      return sessions;
    } catch (error) {
      // ENOENT 表示文件或目录不存在，第一次运行时属于正常情况。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 如果是权限错误、JSON 文件读取错误等其他问题，就向上报告。
        throw error;
      }
    }

    // 没有会话列表时，为默认会话生成相同的创建时间和更新时间。
    const now = new Date().toISOString();

    // 使用固定 ID "default"，这样可以继续使用旧版本的默认会话文件路径。
    const defaultSession: SessionRecord = {
      id: "default",
      title: "默认会话",
      createdAt: now,
      updatedAt: now,
      sessionStatus: "todo",
      isFlagged: false,
    };

    // 把默认会话写入会话列表文件。
    await this.saveSessions([defaultSession]);

    // 把刚创建的默认会话返回给调用者。
    return [defaultSession];
  }

  // 创建一个新会话，并把它加入会话列表。
  async createSession(): Promise<SessionRecord> {
    // 先读取现有会话，创建新列表时不能覆盖它们。
    const sessions = await this.listSessions();

    // 新会话的创建时间和更新时间从同一时刻开始。
    const now = new Date().toISOString();

    // 生成唯一 ID，并设置默认标题。
    const session: SessionRecord = {
      id: randomUUID(),
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      sessionStatus: "todo",
      isFlagged: false,
    };

    // 把新会话放在列表开头，界面可以优先显示它。
    // 其余已有会话仍然保留在数组中。
    await this.saveSessions([session, ...sessions]);

    // 返回新会话信息，让主进程或界面可以切换到它。
    return session;
  }

  // 保存 Claude SDK 返回的会话 ID，确保应用重启后仍能恢复同一段对话。
  async saveSdkSessionId(sessionId: string, sdkSessionId: string): Promise<void> {
    const sessions = await this.listSessions();
    const sessionIndex = sessions.findIndex((session) => session.id === sessionId);

    if (sessionIndex === -1) {
      throw new Error("找不到要保存 SDK 会话 ID 的会话。");
    }

    sessions[sessionIndex] = {
      ...sessions[sessionIndex],
      sdkSessionId,
    };

    await this.saveSessions(sessions);
  }

  // 保存会话的工具权限模式；旧会话没有此字段时按 ask 模式处理。
  async savePermissionMode(
    sessionId: string,
    permissionMode: NonNullable<SessionRecord["permissionMode"]>,
  ): Promise<void> {
    const sessions = await this.listSessions();
    const sessionIndex = sessions.findIndex((session) => session.id === sessionId);
    if (sessionIndex === -1) throw new Error("找不到要更新权限模式的会话。");

    sessions[sessionIndex] = { ...sessions[sessionIndex], permissionMode };
    await this.saveSessions(sessions);
  }

  // 更新会话在 Inbox 中的工作流状态，不修改聊天消息 JSONL。
  async saveStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord> {
    return this.updateSession(sessionId, { sessionStatus: status });
  }

  // 更新会话是否被标记，供列表快速识别重要任务。
  async saveFlag(sessionId: string, isFlagged: boolean): Promise<SessionRecord> {
    return this.updateSession(sessionId, { isFlagged });
  }

  // 会话标题、状态、Flag 等元数据统一保存在 index.json。
  private async updateSession(
    sessionId: string,
    changes: Partial<Pick<SessionRecord, "sessionStatus" | "isFlagged">>,
  ): Promise<SessionRecord> {
    const sessions = await this.listSessions();
    const sessionIndex = sessions.findIndex((session) => session.id === sessionId);
    if (sessionIndex === -1) throw new Error("找不到要更新的会话。");

    const updatedSession = { ...sessions[sessionIndex], ...changes };
    sessions[sessionIndex] = updatedSession;
    await this.saveSessions(sessions);
    return updatedSession;
  }

  // 读取指定会话中的全部消息。
  async loadMessages(sessionId: string): Promise<ConversationMessage[]> {
    // 先读取会话列表，确认传入的 ID 确实存在。
    const sessions = await this.listSessions();

    // 如果列表里找不到这个 ID，就拒绝读取不存在的会话。
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new Error("找不到指定会话。");
    }

    try {
      // 读取这个会话自己的 JSONL 文件。
      const text = await readFile(
        this.getSessionFilePath(sessionId),
        "utf8",
      );

      // JSONL 是“每行一个 JSON 对象”：
      // 先按换行拆开，再移除空行，最后逐行还原成消息对象。
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ConversationMessage);
    } catch (error) {
      // 文件不存在表示会话还没有消息，返回空数组即可。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      // 其他问题，例如文件损坏或读取权限错误，不能伪装成空会话。
      throw error;
    }
  }

  // 读取工具事件日志，并把同一 toolCallId 的开始与结果合并成一张卡片。
  async loadToolActivities(sessionId: string): Promise<ToolActivity[]> {
    const sessions = await this.listSessions();
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new Error("找不到指定会话。");
    }

    let text: string;
    try {
      text = await readFile(this.getToolEventsFilePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const activities = new Map<string, ToolActivity>();
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line) as Extract<AgentEvent, { type: "tool_start" | "tool_result" }>;
      if (event.type === "tool_start") {
        activities.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        });
      } else {
        const current = activities.get(event.toolCallId) ?? {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: {},
        };
        activities.set(event.toolCallId, {
          ...current,
          result: event.result,
          isError: event.isError,
        });
      }
    }

    return [...activities.values()];
  }

  // 把工具开始/结束事件追加写入该会话的独立 JSONL 轨迹文件。
  async appendToolEvent(
    sessionId: string,
    event: Extract<AgentEvent, { type: "tool_start" | "tool_result" }>,
  ): Promise<void> {
    const sessions = await this.listSessions();
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new Error("找不到指定会话。");
    }

    const filePath = this.getToolEventsFilePath(sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  // 把一条消息保存到指定会话，并更新会话的最近活动时间。
  async appendMessage(
    sessionId: string,
    message: ConversationMessage,
  ): Promise<void> {
    // 读取会话列表，以便验证 ID 并更新对应会话的时间。
    const sessions = await this.listSessions();

    // 找到目标会话在数组中的位置。
    const sessionIndex = sessions.findIndex(
      (session) => session.id === sessionId,
    );

    // 找不到会话就停止，避免把消息写进错误位置。
    if (sessionIndex === -1) {
      throw new Error("找不到指定会话。");
    }

    // 根据会话 ID 计算它专属的消息文件路径。
    const filePath = this.getSessionFilePath(sessionId);

    // 确保消息文件所在目录存在；新会话通常需要先创建目录。
    await mkdir(path.dirname(filePath), { recursive: true });

    // 把消息对象序列化为一行 JSON，并追加到文件末尾。
    // 末尾的换行符用于让下一条消息从新的一行开始。
    await appendFile(filePath, `${JSON.stringify(message)}\n`, "utf8");

    // 用当前时间更新这个会话的最近活动时间。
    sessions[sessionIndex] = {
      ...sessions[sessionIndex],
      updatedAt: new Date().toISOString(),
    };

    // 把更新后的会话列表写回 index.json。
    await this.saveSessions(sessions);
  }

  // 把完整的会话列表保存到 index.json。
  private async saveSessions(sessions: SessionRecord[]): Promise<void> {
    // 确保用于保存 index.json 的根目录存在。
    await mkdir(this.rootDirectory, { recursive: true });

    // 将会话数组写成格式化 JSON，方便人直接检查文件内容。
    // writeFile 会覆盖旧的 index.json，保存最新会话列表。
    await writeFile(
      this.indexPath,
      JSON.stringify(sessions, null, 2),
      "utf8",
    );
  }
}
