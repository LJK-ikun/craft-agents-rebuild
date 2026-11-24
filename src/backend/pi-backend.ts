import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { createPiSession } from "./pi-session.ts";
import type {
  AgentBackend,
  AgentEvent,
  BackendConfig,
} from "../types.ts";

/**
 * 一个很小的异步事件队列：
 * Pi 通过回调推送事件，AgentBackend.chat() 则通过 async generator 逐条读取。
 */
class AgentEventQueue implements AsyncIterable<AgentEvent> {
  // 暂时还没有消费者读取的事件。
  private readonly events: AgentEvent[] = [];
  // 正在等待下一条事件的读取者。
  private readonly waiters: Array<(event: AgentEvent | null) => void> = [];
  // 事件结束后阻止队列继续接收新事件。
  private closed = false;

  /** 把事件交给一个等待者，或先放进队列等待读取。 */
  push(event: AgentEvent): void {
    if (this.closed) return;

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.events.push(event);
    }
  }

  /** 标记队列结束，并唤醒所有等待中的读取者。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }

  /** 允许调用方使用 for await 按顺序消费所有事件。 */
  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    while (true) {
      const savedEvent = this.events.shift();
      if (savedEvent) {
        yield savedEvent;
        continue;
      }

      if (this.closed) return;

      const nextEvent = await new Promise<AgentEvent | null>((resolve) => {
        this.waiters.push(resolve);
      });

      if (nextEvent === null) return;
      yield nextEvent;
    }
  }
}

/** 把 Pi SDK 的会话事件转换成应用统一的 AgentEvent。 */
export class PiBackend implements AgentBackend {
  // 延迟创建 Pi 会话，并在本后端实例的整个生命周期内复用它。
  private sessionPromise: Promise<AgentSession> | null = null;

  constructor(private readonly config: BackendConfig) {}

  /** 第一次提问时创建 Pi 会话；后续提问继续使用同一个会话。 */
  private getSession(): Promise<AgentSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = createPiSession(this.config);
    }
    return this.sessionPromise;
  }

  /** 发送用户问题，并把 Pi 的流式输出逐条交给主进程。 */
  async *chat(message: string): AsyncGenerator<AgentEvent> {
    let session: AgentSession;

    // 会话初始化失败也转换成统一错误事件，避免泄漏 SDK 错误对象。
    try {
      session = await this.getSession();
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }

    const queue = new AgentEventQueue();

    // 监听 Pi SDK 事件，并只挑当前应用需要的事件转换。
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      // message_update 的 text_delta 是模型刚生成的一段文字。
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        queue.push({
          type: "text_delta",
          text: event.assistantMessageEvent.delta,
        });
      }

      // assistant 消息以 error 结束时，把错误文本交给应用层。
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      ) {
        queue.push({
          type: "error",
          message: event.message.errorMessage || "Pi 模型请求失败。",
        });
      }

      // agent_end 表示这一轮 Pi Agent 工作结束。
      if (event.type === "agent_end") {
        queue.push({ type: "complete" });
        queue.close();
      }
    });

    try {
      // prompt 启动 Pi 的模型循环；SDK 事件由上方订阅回调推入队列。
      const promptTask = session.prompt(message).catch((error: unknown) => {
        queue.push({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        queue.close();
      });

      // Pi 每产生一条文字事件，就立即 yield 给 Electron 主进程。
      for await (const event of queue) {
        yield event;
      }

      // 等待 prompt 本身结束，避免后台请求还没收尾就退出。
      await promptTask;
    } finally {
      // 每轮结束后取消订阅，避免后续问题收到重复事件。
      unsubscribe();
    }
  }
}
