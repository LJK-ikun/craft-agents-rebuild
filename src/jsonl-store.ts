// appendFile：把新消息追加到文件末尾，不覆盖已有消息。
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

// path：安全地拼接当前操作系统认可的文件路径。
import path from "node:path";

// randomUUID：为新会话生成不重复的 ID。
import { randomUUID } from "node:crypto";

// 描述一条聊天消息的数据结构。
// role 表示说话人；content 表示这条消息的文字。
export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

// 描述会话列表里的一项。
// 会话列表只存基本信息，具体聊天消息单独存在 JSONL 文件中。
export type SessionRecord = {
  id: string; // 会话的唯一 ID，用来找到它对应的消息文件。
  title: string; // 会话标题，显示在界面的会话列表中。
  createdAt: string; // 会话创建时间，使用 ISO 时间格式。
  updatedAt: string; // 最近一次保存消息的时间。
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

  // 读取所有会话的基本信息。
  // 如果应用第一次运行、还没有 index.json，就创建一个默认会话。
  async listSessions(): Promise<SessionRecord[]> {
    // 确保会话根文件夹存在；recursive 允许一次创建多层文件夹。
    await mkdir(this.rootDirectory, { recursive: true });

    try {
      // 读取 index.json 的文字内容。
      const text = await readFile(this.indexPath, "utf8");

      // 把 JSON 文字解析成会话记录数组并返回。
      return JSON.parse(text) as SessionRecord[];
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
    };

    // 把新会话放在列表开头，界面可以优先显示它。
    // 其余已有会话仍然保留在数组中。
    await this.saveSessions([session, ...sessions]);

    // 返回新会话信息，让主进程或界面可以切换到它。
    return session;
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