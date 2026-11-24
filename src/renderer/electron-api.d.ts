// 让TypeScript 把本文件当作模块
// 这样下面才能使用 declare global 拓展全局 Window 类型
export {};

// 描述一条聊天消息，和主进程，存储层使用的数据结构一致
type CraftChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// 描述会话列表里展示一项
type CraftSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// 描述一个工作区：rootPath 存 Craft 管理的数据，workingDirectory 是项目目录。
type CraftWorkspace = {
  id: string;
  name: string;
  rootPath: string;
  workingDirectory: string;
  createdAt: string;
};

// 主进程切换工作区后，返回界面要展示的工作区、会话和消息。
type CraftWorkspaceState = {
  workspace: CraftWorkspace;
  sessions: CraftSession[];
  activeSessionId: string;
  messages: CraftChatMessage[];
};

// 扩展浏览器环境中的全局 Window 类型
declare global {
  interface Window {
    // 这是 Prelead 注入给网页的受控API
    craftAgent: {
      // 发送问题，异步取得模型回答
      ask(userText: string): Promise<string>;

      // 读取当前会话的历史消息
      getHistory(): Promise<CraftChatMessage[]>;

      // 获取会话列表，用来显示可切换的会话
      listSessions(): Promise<CraftSession[]>;

      // 创建会话，并返回新会话信息和初始消息列表
      createSession(): Promise<{
        session: CraftSession;
        messages: CraftChatMessage[];
      }>;

      // 切换会话，并取得该会话的历史消息
      selectSession(sessionId: string): Promise<CraftChatMessage[]>;

      // 获取所有已登记的工作区。
      listWorkspaces(): Promise<CraftWorkspace[]>;

      // 选择文件夹并添加工作区；用户取消时返回 null。
      addWorkspace(): Promise<CraftWorkspaceState | null>;

      // 切换到指定工作区，并取得该工作区的初始数据。
      selectWorkspace(workspaceId: string): Promise<CraftWorkspaceState>;

    }
  }
}
