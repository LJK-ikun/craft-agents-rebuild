import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// 一个工作区是应用里被单独命名和寻址的一组本地文件。
// rootPath 指向它的根目录，后续会在此基础上保存配置、会话和来源。
export type WorkspaceRecord = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
};

// 全局工作区清单的文件结构。工作区自身的数据目录和这个清单分开保存。
type WorkspaceRegistry = {
  workspaces: WorkspaceRecord[];
};

// 负责把工作区清单读写到磁盘；窗口和 Agent 不直接操作 JSON 文件。
export class JsonWorkspaceStore {
  constructor(private readonly registryPath: string) {}

  // 读取所有已登记的工作区；首次启动时清单还不存在，所以返回空列表。
  async list(): Promise<WorkspaceRecord[]> {
    let content: string;
    try {
      content = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const registry = JSON.parse(content) as WorkspaceRegistry;
    if (!Array.isArray(registry.workspaces)) {
      throw new Error("工作区清单格式不正确：缺少 workspaces 列表。");
    }
    return registry.workspaces;
  }

  // 创建或取回默认工作区，让应用首次启动时也有一个可用 workspace。
  async ensureDefaultWorkspace(rootPath: string): Promise<WorkspaceRecord> {
    const workspaces = await this.list();
    const existing = workspaces.find((workspace) => workspace.id === "default");
    if (existing) return existing;

    // 先建立工作区目录，确保记录里的 rootPath 真正存在。
    await mkdir(rootPath, { recursive: true });

    const workspace: WorkspaceRecord = {
      id: "default",
      name: "默认工作区",
      rootPath,
      createdAt: new Date().toISOString(),
    };
    await this.save([...workspaces, workspace]);
    return workspace;
  }

  // 保存完整清单，避免调用方在不同地方各自拼 JSON 格式。
  private async save(workspaces: WorkspaceRecord[]): Promise<void> {
    await mkdir(path.dirname(this.registryPath), { recursive: true });
    const registry: WorkspaceRegistry = { workspaces };
    await writeFile(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
}
