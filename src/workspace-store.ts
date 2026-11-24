// 把项目文件夹登记成 Workspace，并为它准备独立的会话、Sources 和 Skills 目录。把项目文件夹登记成 Workspace，并为它准备独立的会话、Sources 和 Skills 目录。
// 文件操作：创建目录、读取文件和保存文件。
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

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