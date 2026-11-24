// 把项目文件夹登记成 Workspace，并为它准备独立的会话、Sources 和 Skills 目录。把项目文件夹登记成 Workspace，并为它准备独立的会话、Sources 和 Skills 目录。
// 文件操作：创建目录、读取文件和保存文件。
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

// 路径工具：根据当前操作系统规则拼接和规范化路径。
import path from "node:path";

// 生成不会重复的工作区 ID。
import { randomUUID } from "node:crypto";

// 工作区列表中保存的最少信息。
export type WorkspaceRecord = {
  id: string;                 // 工作区唯一 ID。
  name: string;               // 界面显示的名称。
  rootPath: string;           // 应用管理工作区资料的目录。
  workingDirectory: string;   // Agent 实际工作的项目目录。
  createdAt: string;           // 工作区创建时间。
};

export type WorkspaceResourceKind = "source" | "skill";

export type WorkspaceResource = {
  name: string;
  kind: WorkspaceResourceKind;
  size: number;
  updatedAt: string;
};

// 原版 Craft 的一个工作区可以自定义状态显示和 Inbox/Archive 分类。
export type WorkspaceStatus = {
  id: string;
  label: string;
  color?: string;
  icon?: string;
  category: "open" | "closed";
  isFixed: boolean;
  isDefault: boolean;
  order: number;
};

export type WorkspaceStatusConfig = {
  version: number;
  statuses: WorkspaceStatus[];
  defaultStatusId: string;
};

// 默认值对齐原版 statuses/config.json 的五种状态。
function defaultStatusConfig(): WorkspaceStatusConfig {
  return {
    version: 1,
    statuses: [
      { id: "backlog", label: "Backlog", category: "open", isFixed: false, isDefault: true, order: 0 },
      { id: "todo", label: "Todo", category: "open", isFixed: true, isDefault: false, order: 1 },
      { id: "needs-review", label: "Needs Review", category: "open", isFixed: false, isDefault: true, order: 2 },
      { id: "done", label: "Done", category: "closed", isFixed: true, isDefault: false, order: 3 },
      { id: "cancelled", label: "Cancelled", category: "closed", isFixed: true, isDefault: false, order: 4 },
    ],
    defaultStatusId: "todo",
  };
}

// 负责工作区列表和单个工作区目录的读写。
export class WorkspaceStore {
  // rootDirectory 是所有工作区资料的共同父目录。
  constructor(private readonly rootDirectory: string) {}

  // 工作区列表文件路径，例如 userData/workspaces/index.json。
  private get indexPath(): string {
    return path.join(this.rootDirectory, "index.json");
  }

  // 读取全部工作区；首次使用时还没有 index.json，所以返回空列表。
  async list(): Promise<WorkspaceRecord[]> {
    await mkdir(this.rootDirectory, { recursive: true });

    try {
      const text = await readFile(this.indexPath, "utf8");
      return JSON.parse(text) as WorkspaceRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  // 把一个已有项目目录登记为工作区。
  async addWorkspace(workingDirectory: string): Promise<WorkspaceRecord> {
    // 把用户输入整理成绝对路径，避免相对路径和路径写法不同造成重复。
    const normalizedPath = path.resolve(workingDirectory);

    // 确认传入的路径确实存在，而且是文件夹。
    const directoryInfo = await stat(normalizedPath);
    if (!directoryInfo.isDirectory()) {
      throw new Error("工作区路径必须是文件夹。");
    }

    // 读取已有工作区，避免同一个项目目录被重复登记。
    const workspaces = await this.list();
    const existing = workspaces.find((workspace) => {
      const savedPath = path.resolve(workspace.workingDirectory);

      // Windows 路径通常不区分大小写；其他系统按原样比较。
      return process.platform === "win32"
        ? savedPath.toLowerCase() === normalizedPath.toLowerCase()
        : savedPath === normalizedPath;
    });

    // 如果项目目录已经登记，就返回原记录，不再创建一份。
    if (existing) return existing;

    // 用新 ID 给这个工作区分配一个独立的资料目录。
    const id = randomUUID();
    const rootPath = path.join(this.rootDirectory, id);

    // 工作区名字先取项目文件夹名称。
    const name = path.basename(normalizedPath) || "工作区";

    // 组装并保存工作区的基本信息。
    const workspace: WorkspaceRecord = {
      id,
      name,
      rootPath,
      workingDirectory: normalizedPath,
      createdAt: new Date().toISOString(),
    };

    // 为这个工作区创建自己的资料目录和功能子目录。
    await mkdir(path.join(rootPath, "sessions"), { recursive: true });
    await mkdir(path.join(rootPath, "sources"), { recursive: true });
    await mkdir(path.join(rootPath, "skills"), { recursive: true });
    await this.saveStatusConfigForRoot(rootPath, defaultStatusConfig());

    // 在工作区自己的目录中保存配置。
    await writeFile(
      path.join(rootPath, "config.json"),
      JSON.stringify(workspace, null, 2),
      "utf8",
    );

    // 更新总工作区列表，并把新工作区放到列表最前面。
    await this.save([workspace, ...workspaces]);

    return workspace;
  }

  // 读取工作区状态配置；旧工作区缺文件时创建原版默认配置。
  async getStatusConfig(workspaceId: string): Promise<WorkspaceStatusConfig> {
    const workspace = await this.getWorkspace(workspaceId);
    const configPath = path.join(workspace.rootPath, "statuses", "config.json");

    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as WorkspaceStatusConfig;
      if (!this.isValidStatusConfig(config)) return defaultStatusConfig();
      return { ...config, statuses: [...config.statuses].sort((a, b) => a.order - b.order) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const defaults = defaultStatusConfig();
      await this.saveStatusConfigForRoot(workspace.rootPath, defaults);
      return defaults;
    }
  }

  // 保存状态配置；检查默认状态和原版要求保留的固定状态仍然存在。
  async saveStatusConfig(workspaceId: string, config: WorkspaceStatusConfig): Promise<void> {
    if (!this.isValidStatusConfig(config)) throw new Error("工作区状态配置无效。");
    const workspace = await this.getWorkspace(workspaceId);
    await this.saveStatusConfigForRoot(workspace.rootPath, config);
  }

  private isValidStatusConfig(config: WorkspaceStatusConfig): boolean {
    if (!config || !Array.isArray(config.statuses) || typeof config.defaultStatusId !== "string") return false;
    if (!config.statuses.every((status) =>
      status &&
      typeof status.id === "string" &&
      typeof status.label === "string" &&
      (status.category === "open" || status.category === "closed") &&
      typeof status.isFixed === "boolean" &&
      typeof status.isDefault === "boolean" &&
      typeof status.order === "number",
    )) return false;
    const ids = new Set(config.statuses.map((status) => status.id));
    return ids.has(config.defaultStatusId) && ["todo", "done", "cancelled"].every((id) =>
      config.statuses.some((status) => status.id === id && status.isFixed),
    );
  }

  private async saveStatusConfigForRoot(
    workspaceRoot: string,
    config: WorkspaceStatusConfig,
  ): Promise<void> {
    const statusDirectory = path.join(workspaceRoot, "statuses");
    await mkdir(statusDirectory, { recursive: true });
    await writeFile(path.join(statusDirectory, "config.json"), JSON.stringify(config, null, 2), "utf8");
  }

  // 列出工作区中已导入的 Sources 文档或 Skills Markdown 文件。
  async listResources(
    workspaceId: string,
    kind: WorkspaceResourceKind,
  ): Promise<WorkspaceResource[]> {
    const workspace = await this.getWorkspace(workspaceId);
    const resourceDirectory = this.resourceDirectory(workspace, kind);
    await mkdir(resourceDirectory, { recursive: true });

    const entries = await readdir(resourceDirectory, { withFileTypes: true });
    const resources: WorkspaceResource[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (kind === "skill" && extension !== ".md") continue;
      if (kind === "source" && extension !== ".md" && extension !== ".txt") continue;
      const fileInfo = await stat(path.join(resourceDirectory, entry.name));
      resources.push({
        name: entry.name,
        kind,
        size: fileInfo.size,
        updatedAt: fileInfo.mtime.toISOString(),
      });
    }
    return resources.sort((left, right) => left.name.localeCompare(right.name));
  }

  // 把用户选中的知识文件或 Skill 复制到 Craft 管理的工作区资源目录。
  async addResource(
    workspaceId: string,
    kind: WorkspaceResourceKind,
    sourcePath: string,
  ): Promise<WorkspaceResource> {
    const workspace = await this.getWorkspace(workspaceId);
    const normalizedSource = path.resolve(sourcePath);
    const sourceInfo = await stat(normalizedSource);
    if (!sourceInfo.isFile()) throw new Error("只能导入文件。");

    const extension = path.extname(normalizedSource).toLowerCase();
    const allowedExtensions = kind === "skill" ? [".md"] : [".md", ".txt"];
    if (!allowedExtensions.includes(extension)) {
      throw new Error(kind === "skill" ? "Skill 只支持 Markdown 文件。" : "知识文件只支持 Markdown 或 TXT。");
    }

    const resourceDirectory = this.resourceDirectory(workspace, kind);
    await mkdir(resourceDirectory, { recursive: true });
    const targetPath = await this.uniqueResourcePath(resourceDirectory, path.basename(normalizedSource));
    await copyFile(normalizedSource, targetPath);
    const savedInfo = await stat(targetPath);
    return {
      name: path.basename(targetPath),
      kind,
      size: savedInfo.size,
      updatedAt: savedInfo.mtime.toISOString(),
    };
  }

  private async getWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    const workspaces = await this.list();
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("找不到指定工作区。");
    return workspace;
  }

  private resourceDirectory(workspace: WorkspaceRecord, kind: WorkspaceResourceKind): string {
    return path.join(workspace.rootPath, kind === "source" ? "sources" : "skills");
  }

  // 同名文件不覆盖旧内容，自动追加序号保留两份导入文件。
  private async uniqueResourcePath(directory: string, fileName: string): Promise<string> {
    const extension = path.extname(fileName);
    const baseName = path.basename(fileName, extension);
    let candidate = path.join(directory, fileName);
    let suffix = 2;
    while (true) {
      try {
        await stat(candidate);
        candidate = path.join(directory, baseName + "-" + suffix + extension);
        suffix += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
        throw error;
      }
    }
  }

  // 将工作区列表写入 index.json。
  private async save(workspaces: WorkspaceRecord[]): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });

    await writeFile(
      this.indexPath,
      JSON.stringify(workspaces, null, 2),
      "utf8",
    );
  }
}
