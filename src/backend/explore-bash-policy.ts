import parseBash from "bash-parser";

type BashWord = {
  type: "Word";
  text: string;
  expansion?: unknown[];
};

type BashCommand = {
  type: "Command";
  name?: BashWord;
  prefix?: unknown[];
  suffix?: unknown[];
};

type BashScript = {
  type: "Script";
  commands?: unknown[];
};

export type BashPolicyResult = { allowed: true } | { allowed: false; reason: string };

// Explore 模式仅放行少量、单条、无重定向/管道/变量展开的只读命令。
// 复杂语法会拒绝；用户可以切到 Ask 模式请求执行。
export function checkExploreBashCommand(command: string): BashPolicyResult {
  if (!command.trim() || /[\u0000-\u001f\u007f]/.test(command)) {
    return { allowed: false, reason: "命令为空或包含控制字符。" };
  }

  let parsed: unknown;
  try {
    parsed = parseBash(command);
  } catch {
    return { allowed: false, reason: "命令无法安全解析。" };
  }

  const script = parsed as BashScript;
  const node = script.type === "Script" && script.commands?.length === 1
    ? script.commands[0] as BashCommand
    : undefined;

  // 只接受一个简单命令。组合命令、管道、重定向和子 Shell 一律拒绝。
  if (!node || node.type !== "Command" || node.prefix?.length) {
    return { allowed: false, reason: "探索模式只允许单条简单命令，不允许组合命令或重定向。" };
  }

  const words = [node.name, ...(node.suffix ?? [])];
  if (words.some((word) => {
    const candidate = word as Partial<BashWord>;
    return candidate.type !== "Word" || typeof candidate.text !== "string" || candidate.expansion?.length;
  })) {
    return { allowed: false, reason: "命令包含重定向、变量展开或其他非简单参数。" };
  }

  const [program, ...args] = words.map((word) => (word as BashWord).text);
  if (program === "pwd" || program === "ls") {
    return args.length === 0
      ? { allowed: true }
      : { allowed: false, reason: `${program} 在探索模式下暂时只允许查看当前目录。` };
  }

  if (program !== "git" || !args[0]) {
    return { allowed: false, reason: "该命令不在探索模式的只读白名单中。" };
  }

  const [subcommand, ...options] = args;
  const allowedOptions: Record<string, string[]> = {
    status: ["--short", "--branch", "--porcelain", "--untracked-files=no"],
    diff: ["--stat", "--name-only", "--name-status", "--check", "--numstat", "--shortstat"],
    log: [],
    branch: ["--show-current", "--list", "-a", "--all"],
    "rev-parse": ["--show-toplevel", "--is-inside-work-tree", "--show-prefix"],
    show: [],
  };

  const permitted = allowedOptions[subcommand];
  if (!permitted || options.some((option) => !permitted.includes(option))) {
    return { allowed: false, reason: `git ${subcommand} 不在探索模式的只读白名单中。` };
  }

  return { allowed: true };
}
