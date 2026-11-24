// 让TypeScript 把本文件当作模块
// 这样下面才能使用 declare global 拓展全局 Window 类型
import type { AgentEvent } from "../types.ts";
import type { ToolActivity } from "../types.ts";
import type { RpcConnectionState } from "../transport/rpc-client.ts";
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
  permissionMode?: "explore" | "ask" | "execute";
  status?: "todo" | "in_progress" | "needs_review" | "done" | "cancelled";
  isFlagged?: boolean;
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
  toolActivities: ToolActivity[];
  sources: CraftWorkspaceResource[];
  skills: CraftWorkspaceResource[];
};

type CraftWorkspaceResource = {
  name: string;
  kind: "source" | "skill";
  size: number;
  updatedAt: string;
};

// 扩展浏览器环境中的全局 Window 类型
declare global {
  interface Window {
    // 这是 Prelead 注入给网页的受控API
    craftAgent: {
      // 发送问题，异步取得模型回答
      ask(userText: string): Promise<string>;

      // 请求停止当前运行；没有活动请求时返回 false。
      cancel(): Promise<boolean>;

      // 回答主进程发来的工具权限请求，approved 决定放行还是拒绝。
      respondToPermission(requestId: string, approved: boolean): Promise<void>;

      // 设置该会话的工具权限：探索只读、询问逐次确认、执行自动放行。
      setPermissionMode(mode: "explore" | "ask" | "execute"): Promise<string>;

      // 订阅模型运行事件；返回函数用于取消订阅。
      onAgentEvent(callback: (event: AgentEvent) => void): () => void;

      // 事件缓存过期、需要完整刷新时收到通知。
      onTransportStale(callback: () => void): () => void;

      // 观察 WebSocket-RPC 的连接状态变化。
      onConnectionStateChanged(callback: (state: RpcConnectionState) => void): () => void;

      // 检查服务端握手时公布的频道列表。
      isChannelAvailable(channel: string): boolean;

      // 读取当前会话的历史消息
      getHistory(): Promise<CraftChatMessage[]>;

      // 获取会话列表，用来显示可切换的会话
      listSessions(): Promise<CraftSession[]>;

      // 修改一个会话的工作流状态，并返回保存后的会话记录。
      setSessionStatus(sessionId: string, status: NonNullable<CraftSession["status"]>): Promise<CraftSession>;

      // 修改会话的 Flag 标记，并返回保存后的会话记录。
      setSessionFlag(sessionId: string, isFlagged: boolean): Promise<CraftSession>;

      // 创建会话，并返回新会话信息和初始消息列表
      createSession(): Promise<{
        session: CraftSession;
        messages: CraftChatMessage[];
      }>;

      // 切换会话，并取得该会话的历史消息
      selectSession(sessionId: string): Promise<{
        messages: CraftChatMessage[];
        toolActivities: ToolActivity[];
      }>;

      // 获取所有已登记的工作区。
      listWorkspaces(): Promise<CraftWorkspace[]>;

      // 选择文件夹并添加工作区；用户取消时返回 null。
      addWorkspace(): Promise<CraftWorkspaceState | null>;

      // 从原文件复制知识文档或 Skill 到当前工作区的托管目录。
      addWorkspaceResource(kind: "source" | "skill"): Promise<CraftWorkspaceResource[]>;

      // 切换到指定工作区，并取得该工作区的初始数据。
      selectWorkspace(workspaceId: string): Promise<CraftWorkspaceState>;

      // 事件无法补发时，恢复指定工作区和会话的数据。
      restoreWorkspaceState(workspaceId: string, sessionId: string): Promise<CraftWorkspaceState>;

    }
  }
}
