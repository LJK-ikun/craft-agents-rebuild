// 导入后面读写会话文件需要用到的 Node.js 工具。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// 一条会话记录只保存说话人和消息内容。
export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

// 这个类负责管理一个 JSONL 会话文件。
export class JsonlSessionStore {
  constructor(private readonly filePath: string) {}

  async loadMessages(): Promise<ConversationMessage[]> {
    let text: string;
  
    try {
      // 读取会话文件的全部文字内容。
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      // 文件还不存在，说明是新会话，返回空列表。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
  
      // 其他错误不能当作“新会话”，继续交给上层处理。
      throw error;
    }
  
    // 每一行是一条 JSON 消息：拆行、去掉空行，再逐行还原成对象。
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConversationMessage);
  }
  async appendMessage(message: ConversationMessage): Promise<void> {
    // 确保会话文件所在的文件夹已经存在。
    await mkdir(path.dirname(this.filePath), { recursive: true });
  
    // 把消息对象转成一行 JSON，追加到文件末尾。
    await appendFile(
      this.filePath,
      `${JSON.stringify(message)}\n`,
      "utf8",
    );
  }
}
