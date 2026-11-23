import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../provider.ts";

type SessionHeader = {
  type: "session";
  id: string;
  createdAt: string;
};

type StoredMessage = {
  type: "message";
  role: ChatMessage["role"];
  content: string;
};

// 把一个会话保存成 JSONL：第一行是会话信息，后续每行是一条消息。
export class JsonlSessionStore {
  constructor(
    private readonly filePath: string,
    private readonly sessionId: string,
  ) {}

  // 启动时读取文件，只还原 user/assistant 消息；system 提示词由 Agent 自己添加。
  async loadMessages(): Promise<ChatMessage[]> {
    let fileContent: string;
    try {
      fileContent = await readFile(this.filePath, "utf8");
    } catch (error) {
      // 第一次启动还没有会话文件，按空对话处理。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const messages: ChatMessage[] = [];
    for (const line of fileContent.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line) as SessionHeader | StoredMessage;
      if (record.type === "message") {
        messages.push({ role: record.role, content: record.content });
      }
    }
    return messages;
  }

  // 追加一条消息，不重写整份历史记录。
  async appendMessage(message: ChatMessage): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      // 文件不存在时，先写会话头；之后每条消息占一行。
      const header: SessionHeader = {
        type: "session",
        id: this.sessionId,
        createdAt: new Date().toISOString(),
      };
      await writeFile(this.filePath, `${JSON.stringify(header)}\n`, "utf8");
    }

    const record: StoredMessage = {
      type: "message",
      role: message.role,
      content: message.content,
    };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
