import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentBackend, AgentEvent, BackendConfig } from "../types.ts";

// 主进程和 Pi 子进程只交换 JSONL 消息，不共享 SDK 对象。
type PiServerResponse =
  | { type: "ready" }
  | { type: "event"; id: string; event: AgentEvent }
  | { type: "permission_request"; id: string; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "error"; id?: string; message: string };

/**
 * 把回调式的子进程事件转换成可供 for-await 消费的异步队列。
 * Pi 子进程写一行 JSONL，客户端解析后把事件推入这个队列。
 */
class AgentEventQueue implements AsyncIterable<AgentEvent> {
  // 暂时没有被消费者取走的事件。
  private readonly events: AgentEvent[] = [];
  // 正在等待下一条事件的消费者。
  private readonly waiters: Array<(event: AgentEvent | null) => void> = [];
  // 队列关闭后不再接受事件。
  private closed = false;

  /** 收到事件时唤醒等待者；没有等待者时先缓存事件。 */
  push(event: AgentEvent): void {
    if (this.closed) return;

    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }

  /** 通知消费者本轮事件流结束。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }

  /** 让调用方按顺序逐条读取事件。 */
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

/** 每个正在运行的提问都拥有自己的事件队列。 */
type PendingAsk = { events: AgentEventQueue };

/**
 * Electron 主进程中的 Pi 客户端。
 * 真正的 Pi SDK 会在 Bun 子进程运行，避免把 SDK 运行时放进 Electron 主进程。
 */
export class PiBackend implements AgentBackend {
  // 子进程句柄；stdin/stdout/stderr 都是可用的管道。
  private readonly child: ChildProcessWithoutNullStreams;
  // 等待 Pi 子进程完成初始化后，chat 才能发送问题。
  private readonly ready: Promise<void>;
  // 用 request ID 将并发中的问题和对应事件流配对。
  private readonly pending = new Map<string, PendingAsk>();
  // 初始化 Promise 的回调由 ready 消息或启动错误触发。
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  // 防止进程退出后又被误认为仍可使用。
  private exited = false;

  constructor(
    private readonly config: BackendConfig,
    serverScript: string,
  ) {
    // Pi SDK 放进独立 Bun 进程；Electron 主进程只负责 JSONL 通信。
    const bunExecutable = process.env.BUN_EXECUTABLE || "bun";
    this.child = spawn(bunExecutable, ["run", serverScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // 先注册 ready Promise 的回调，再监听 stdout，避免漏掉快速返回的 ready。
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 先登记拒绝处理，避免子进程在用户第一次提问前启动失败时产生未处理 Promise。
    void this.ready.catch(() => undefined);

    // stdout 是 JSONL 协议通道：每一行都必须是一个完整 JSON 消息。
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => this.handleServerLine(line));

    // stderr 只承载诊断日志，不会污染 stdout 上的 JSONL 协议。
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[Pi server] ${chunk.toString()}`);
    });

    // 启动失败时，让初始化和所有等待中的提问都收到明确错误。
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.failAll(
        new Error(`Pi 子进程退出：code=${code ?? "null"}, signal=${signal ?? "null"}`),
      );
    });

    // 初始化消息把模型和凭证交给 Pi 子进程；密钥不会发给 Renderer。
    this.write({
      type: "init",
      cwd: config.workingDirectory,
      provider: config.piAuthProvider,
      model: config.model,
      apiKey: config.apiKey,
      systemPrompt: config.systemPrompt,
      sessionDirectory: config.piSessionDirectory,
      permissionMode: config.permissionMode,
    });
  }

  /** 启动一次提问，并实时产出 Pi 子进程发回的事件。 */
  async *chat(message: string): AsyncGenerator<AgentEvent> {
    try {
      // Pi session 初始化完成前不能发送 ask。
      await this.ready;

      if (this.exited) throw new Error("Pi 子进程已经退出。");

      // request ID 让多个请求的结果不会串到错误的聊天流里。
      const id = randomUUID();
      const events = new AgentEventQueue();
      this.pending.set(id, { events });

      try {
        this.write({ type: "ask", id, message });
      } catch (error) {
        this.pending.delete(id);
        events.push({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        events.close();
      }

      // 收到一条就向上 yield 一条，Renderer 可以逐段显示模型回答。
      for await (const event of events) {
        yield event;
      }
    } catch (error) {
      // 启动或等待初始化失败时，也通过统一 AgentEvent 告诉 UI。
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 把界面的允许/拒绝结果送回 Pi 子进程，解除工具执行的等待。 */
  respondToPermission(requestId: string, approved: boolean): void {
    this.write({ type: "permission_response", requestId, approved });
  }

  /** 将会话权限模式变更通知正在运行的 Pi 子进程。 */
  setPermissionMode(mode: "explore" | "ask" | "execute"): void {
    this.write({ type: "set_permission_mode", mode });
  }

  /** 请求 Pi SDK 中止当前 prompt。 */
  async cancel(): Promise<void> {
    if (!this.exited) this.write({ type: "cancel" });
  }

  /** 关闭当前会话的 Pi 子进程，避免切换工作区后遗留后台进程。 */
  async dispose(): Promise<void> {
    if (this.exited) return;

    // 通知子进程释放 Pi session，然后结束 stdin，作为额外的关闭信号。
    try {
      this.write({ type: "close" });
      this.child.stdin.end();
    } catch {
      this.child.kill();
    }

    // 正常等待子进程退出；若 SDK 未能及时退出，再强制结束它。
    await Promise.race([
      once(this.child, "exit").then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.exited) this.child.kill();
          resolve();
        }, 2_000);
        timer.unref();
      }),
    ]);
  }

  /** 解析子进程的一行 JSONL 响应，并路由到对应请求。 */
  private handleServerLine(line: string): void {
    let response: PiServerResponse;

    try {
      response = JSON.parse(line) as PiServerResponse;
    } catch {
      process.stderr.write(`[Pi server] 忽略无效 JSONL：${line}\n`);
      return;
    }

    // ready 表示 SDK、模型和会话初始化完成。
    if (response.type === "ready") {
      this.resolveReady();
      return;
    }

    // 没有 request ID 的错误发生在会话初始化阶段。
    if (response.type === "error" && !response.id) {
      this.rejectReady(new Error(response.message));
      return;
    }

    if (!response.id) return;
    const pendingAsk = this.pending.get(response.id);
    if (!pendingAsk) return;

    if (response.type === "event") {
      pendingAsk.events.push(response.event);

      // 完成或失败事件到达后关闭对应异步流并清理映射。
      if (
        response.event.type === "complete" ||
        response.event.type === "error" ||
        response.event.type === "cancelled"
      ) {
        pendingAsk.events.close();
        this.pending.delete(response.id);
      }
      return;
    }

    if (response.type === "permission_request") {
      pendingAsk.events.push({
        type: "permission_request",
        requestId: response.requestId,
        toolName: response.toolName,
        input: response.input,
      });
      return;
    }

    pendingAsk.events.push({ type: "error", message: response.message });
    pendingAsk.events.close();
    this.pending.delete(response.id);
  }

  /** 子进程意外退出时，拒绝启动等待并结束所有活跃事件流。 */
  private failAll(error: Error): void {
    this.exited = true;
    this.rejectReady(error);

    for (const [id, pendingAsk] of this.pending) {
      pendingAsk.events.push({ type: "error", message: error.message });
      pendingAsk.events.close();
      this.pending.delete(id);
    }
  }

  /** 把一个对象编码成单行 JSON，再写入子进程 stdin。 */
  private write(message: object): void {
    if (this.child.stdin.destroyed || this.exited) {
      throw new Error("Pi 子进程输入管道已关闭。");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/** 构建产物中的 main.mjs 位于 dist，因此 Pi server 也从 dist/backend 加载。 */
export function resolvePiServerScript(mainDirectory: string): string {
  return path.join(mainDirectory, "backend", "pi-agent-server.js");
}
