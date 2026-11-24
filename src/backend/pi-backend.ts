import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentBackend, BackendConfig } from "./types.ts";

type PiResponse =
  | { type: "ready" }
  | { type: "answer"; id: string; answer: string }
  | { type: "error"; id?: string; error: string };

// PiBackend 是 Electron 主进程里的客户端；真正的 Pi SDK 在 Bun 子进程运行。
export class PiBackend implements AgentBackend {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (answer: string) => void; reject: (error: Error) => void }
  >();
  private readonly ready: Promise<void>;

  constructor(config: BackendConfig, serverScript: string) {
    // Bun 运行时满足 Pi SDK 的运行要求，并与 Electron 的 Node 环境隔离。
    this.child = spawn(process.env.BUN_EXECUTABLE || "bun", ["run", serverScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleResponse(line));

    this.child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[Pi backend] ${chunk.toString().trimEnd()}`);
    });

    this.child.on("exit", (code) => {
      const error = new Error(`Pi 服务进程已退出（${code ?? "unknown"}）。`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });

    this.ready = this.waitForReady();
    this.write({
      type: "init",
      cwd: config.workingDirectory,
      provider: config.provider || "anthropic",
      model: config.model,
      apiKey: config.apiKey,
    });
  }

  async ask(message: string): Promise<string> {
    await this.ready;
    const id = randomUUID();

    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ type: "ask", id, message });
    });
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.write({ type: "close" });
    this.child.kill();
  }

  private async waitForReady(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onResponse = (response: PiResponse) => {
        if (response.type === "ready") {
          this.removeResponseListener(onResponse);
          resolve();
        } else if (response.type === "error") {
          this.removeResponseListener(onResponse);
          reject(new Error(response.error));
        }
      };

      this.addResponseListener(onResponse);
      this.child.once("error", (error) => {
        this.removeResponseListener(onResponse);
        reject(error);
      });
    });
  }

  private readonly responseListeners = new Set<(response: PiResponse) => void>();

  private addResponseListener(listener: (response: PiResponse) => void): void {
    this.responseListeners.add(listener);
  }

  private removeResponseListener(listener: (response: PiResponse) => void): void {
    this.responseListeners.delete(listener);
  }

  private handleResponse(line: string): void {
    let response: PiResponse;
    try {
      response = JSON.parse(line) as PiResponse;
    } catch {
      console.error("Pi 服务返回了无效的 JSONL。", line);
      return;
    }

    for (const listener of this.responseListeners) listener(response);

    if (!response.id) return;
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);

    if (response.type === "answer") request.resolve(response.answer);
    if (response.type === "error") request.reject(new Error(response.error));
  }

  private write(value: object): void {
    if (this.child.stdin.destroyed) throw new Error("Pi 服务进程输入流已关闭。");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
}

// 开发构建把 main.mjs 放在 dist，因此 Pi server 的 TypeScript 源位于上一级 src。
export function resolvePiServerScript(mainDirectory: string): string {
  return `${mainDirectory}/backend/pi-agent-server.js`;
}
