import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type BgState = "running" | "completed" | "failed" | "killed" | "stale";
type BgOriginSurface = "telegram" | "whatsapp" | "pi-console" | "scheduler" | "putio-downloader" | "media-mover" | "unknown";
type BgReplyPolicy = "none" | "main-review" | "errors-only";

interface BgStartParams {
  name: string;
  prompt: string;
  timeoutSeconds?: number;
  model?: string;
  provider?: string;
  thinking?: string;
}

interface BgTaskOrigin {
  surface: BgOriginSurface;
  requestId?: string;
  sessionId?: string;
  spawnedAtUtc: string;
  replyExpected: boolean;
  replyPolicy: BgReplyPolicy;
  correlation: Record<string, string>;
}

interface BgTask {
  id: string;
  name: string;
  scope: string;
  origin: BgTaskOrigin;
  state: BgState;
  cwd: string;
  pid?: number;
  promptPath: string;
  outputPath: string;
  metadataPath: string;
  startedAtUtc: string;
  completedAtUtc?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

interface BgRegistry {
  version: 1;
  updatedAtUtc: string;
  tasks: BgTask[];
}

const tasks = new Map<string, BgTask>();
let currentCtx: ExtensionContext | undefined;

const REGISTRY_FILE_NAME = "registry.json";
const REGISTRY_LOCK_DIR_NAME = "registry.lock";
const REGISTRY_LOCK_STALE_MS = 60_000;
const REGISTRY_TASK_WITHOUT_PID_STALE_MS = 10 * 60_000;

export const CHILD_ENV_FLAG = "PI_BACKGROUND_CHILD";

export const CHILD_DENIED_TOOLS = [
  // Outward/public messaging belongs to the parent session only.
  "whatsapp_send_message",
  "whatsapp_send_image",
  "whatsapp_set_busy",
  "telegram_send_file",
  "telegram_start",
  "telegram_enable",
  "telegram_release",
  "telegram_remove_bot",
  // Children must not spawn more children unless explicitly reworked later.
  "bg_start",
];

const CHILD_DENIED_TOOL_SET = new Set(CHILD_DENIED_TOOLS);

const CHILD_BLOCKED_BRIDGE_PATTERNS = [
  /whatsapp[_-]send[_-](message|image)/i,
  /whatsapp[_-]set[_-]busy/i,
  /telegram[_-]send[_-]file/i,
  /api\.telegram\.org\/bot[^\s]+\/send(?:Message|Photo|Document|Video|Audio|MediaGroup)/i,
  /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|fetch)\b[\s\S]*(?:whatsapp|telegram)[\s\S]*(?:send|message|image|busy|document)/i,
  /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|fetch)\b[\s\S]*(?:127\.0\.0\.1|localhost)[\s\S]*(?:send|message|image|busy|telegram|whatsapp)/i,
];

export function isBackgroundChild(): boolean {
  return process.env[CHILD_ENV_FLAG] === "1";
}

export function withoutDeniedTools(tools: string[]): string[] {
  return tools.filter((tool) => !CHILD_DENIED_TOOL_SET.has(tool));
}

function shellCommandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function includesDeniedNestedTool(input: unknown): string | undefined {
  const json = JSON.stringify(input ?? "");
  return CHILD_DENIED_TOOLS.find((tool) => json.includes(tool));
}

function bridgePatternReason(command: string): string | undefined {
  return CHILD_BLOCKED_BRIDGE_PATTERNS.find((pattern) => pattern.test(command))?.source;
}

export function backgroundChildBlockReason(toolName: string, input: unknown): string | undefined {
  if (CHILD_DENIED_TOOL_SET.has(toolName)) {
    return `Background child isolation blocks outward/recursive tool: ${toolName}`;
  }

  if (toolName.includes("multi_tool_use")) {
    const nestedTool = includesDeniedNestedTool(input);
    if (nestedTool) return `Background child isolation blocks nested outward/recursive tool: ${nestedTool}`;
  }

  if (toolName === "bash" || toolName === "powershell") {
    const command = shellCommandFromInput(input);
    const reason = command ? bridgePatternReason(command) : undefined;
    if (reason) return `Background child isolation blocks bridge-send shell command (${reason})`;
  }

  return undefined;
}

export function childEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized.includes("WHATSAPP") || normalized.includes("TELEGRAM") || normalized.includes("SESSION_PUSH")) {
      delete env[key];
    }
  }
  return {
    ...env,
    PI_SESSION_PUSH_DISABLED: "1",
    [CHILD_ENV_FLAG]: "1",
    TELEGRAMPI_DISABLED: "1",
  };
}

const BgStartParams = Type.Object({
  name: Type.String({ description: "Short human-readable name for this background Pi task." }),
  prompt: Type.String({ description: "Complete prompt/task brief for the background Pi subagent." }),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds." })),
  provider: Type.Optional(Type.String({ description: "Optional Pi provider argument." })),
  model: Type.Optional(Type.String({ description: "Optional Pi model argument." })),
  thinking: Type.Optional(Type.String({ description: "Optional Pi thinking level." })),
});

function makeId(): string {
  return `bg_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "task";
}

export function normalizeTaskScope(name: string): string {
  return sanitizePathSegment(name.trim().toLowerCase()).replace(/^_+|_+$/g, "") || "task";
}

function extractLine(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:\\s*(.+)$`, "im").exec(text);
  return match?.[1]?.trim();
}

export function detectOriginFromText(text: string, options: { sessionId?: string; spawnedAtUtc?: string } = {}): BgTaskOrigin {
  const spawnedAtUtc = options.spawnedAtUtc ?? new Date().toISOString();
  const base = {
    sessionId: options.sessionId,
    spawnedAtUtc,
    correlation: {} as Record<string, string>,
  };

  const telegramRequestId = /\[Pi Telegram request:\s*([^\]]+)\]/i.exec(text)?.[1]?.trim();
  if (/\[Message from Telegram/i.test(text) || telegramRequestId) {
    return {
      ...base,
      surface: "telegram",
      requestId: telegramRequestId,
      replyExpected: true,
      replyPolicy: "main-review",
      correlation: { ...(telegramRequestId ? { telegramRequestId } : {}) },
    };
  }

  if (/\[from-whatsapp\]/i.test(text)) {
    const replyMode = extractLine(text, "ReplyMode")?.toLowerCase();
    const messageId = extractLine(text, "MessageId") ?? extractLine(text, "Id");
    const senderId = extractLine(text, "SenderId");
    const chatId = extractLine(text, "ChatId");
    const replyExpected = replyMode === "required";
    return {
      ...base,
      surface: "whatsapp",
      requestId: messageId,
      replyExpected,
      replyPolicy: replyExpected ? "main-review" : "none",
      correlation: {
        ...(messageId ? { whatsappMessageId: messageId } : {}),
        ...(senderId ? { senderId } : {}),
        ...(chatId ? { chatId } : {}),
        ...(replyMode ? { replyMode } : {}),
      },
    };
  }

  if (/\[from-scheduler\]/i.test(text)) {
    const jobId = extractLine(text, "JobId");
    const job = extractLine(text, "Job");
    return {
      ...base,
      surface: "scheduler",
      requestId: jobId,
      replyExpected: false,
      replyPolicy: "none",
      correlation: { ...(jobId ? { schedulerJobId: jobId } : {}), ...(job ? { schedulerJob: job } : {}) },
    };
  }

  if (/\[from-putio-downloader\]/i.test(text)) {
    const event = extractLine(text, "Event");
    const putioFileId = extractLine(text, "PutioFileId");
    return {
      ...base,
      surface: "putio-downloader",
      requestId: putioFileId,
      replyExpected: false,
      replyPolicy: "none",
      correlation: { ...(event ? { event } : {}), ...(putioFileId ? { putioFileId } : {}) },
    };
  }

  if (/\[from-media-mover\]/i.test(text)) {
    const event = extractLine(text, "Event");
    const taskId = extractLine(text, "TaskId");
    return {
      ...base,
      surface: "media-mover",
      requestId: taskId,
      replyExpected: false,
      replyPolicy: "none",
      correlation: { ...(event ? { event } : {}), ...(taskId ? { mediaMoverTaskId: taskId } : {}) },
    };
  }

  return {
    ...base,
    surface: text.trim() ? "pi-console" : "unknown",
    replyExpected: false,
    replyPolicy: "none",
    correlation: {},
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function latestUserText(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as unknown as {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
  };
  const entries = manager.getBranch?.() ?? manager.getEntries?.() ?? [];
  for (const entry of [...entries].reverse()) {
    const candidate = entry as { type?: unknown; message?: { role?: unknown; content?: unknown }; role?: unknown; content?: unknown };
    const message = candidate.message ?? candidate;
    if (message.role === "user") return textFromContent(message.content);
  }
  return "";
}

function detectOriginFromContext(ctx: ExtensionContext): BgTaskOrigin {
  const sessionId = (ctx.sessionManager as unknown as { getSessionId?: () => string }).getSessionId?.();
  return detectOriginFromText(latestUserText(ctx), { sessionId });
}

function backgroundDir(cwd: string): string {
  return join(cwd, ".pi", "background");
}

function registryPath(cwd: string): string {
  return join(backgroundDir(cwd), REGISTRY_FILE_NAME);
}

function registryLockDir(cwd: string): string {
  return join(backgroundDir(cwd), REGISTRY_LOCK_DIR_NAME);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function readRegistry(path: string): Promise<BgRegistry> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<BgRegistry>;
    return {
      version: 1,
      updatedAtUtc: typeof parsed.updatedAtUtc === "string" ? parsed.updatedAtUtc : new Date(0).toISOString(),
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks as BgTask[] : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, updatedAtUtc: new Date(0).toISOString(), tasks: [] };
    }
    throw error;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function reapStaleRegistryTasks(
  registry: BgRegistry,
  nowMs = Date.now(),
  pidAlive: (pid: number) => boolean = isPidAlive,
): BgRegistry {
  let changed = false;
  const tasks = registry.tasks.map((task) => {
    if (task.state !== "running") return task;
    const startedMs = Date.parse(task.startedAtUtc);
    const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : Number.POSITIVE_INFINITY;
    const staleBecausePidDead = typeof task.pid === "number" && !pidAlive(task.pid);
    const staleBecausePidMissing = typeof task.pid !== "number" && ageMs > REGISTRY_TASK_WITHOUT_PID_STALE_MS;
    if (!staleBecausePidDead && !staleBecausePidMissing) return task;
    changed = true;
    return {
      ...task,
      state: "stale" as const,
      completedAtUtc: new Date(nowMs).toISOString(),
      error: staleBecausePidDead
        ? `Reaped stale running task; PID ${task.pid} is not alive`
        : "Reaped stale running task; no PID was recorded",
    };
  });
  return changed ? { ...registry, updatedAtUtc: new Date(nowMs).toISOString(), tasks } : registry;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockPid(lockDir: string): Promise<number | undefined> {
  try {
    const text = await readFile(join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(text) as { pid?: unknown };
    return typeof owner.pid === "number" ? owner.pid : undefined;
  } catch {
    return undefined;
  }
}

async function isLockStale(lockDir: string): Promise<boolean> {
  const pid = await readLockPid(lockDir);
  if (typeof pid === "number" && !isPidAlive(pid)) return true;
  try {
    const text = await readFile(join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(text) as { createdAtUtc?: unknown };
    const createdMs = typeof owner.createdAtUtc === "string" ? Date.parse(owner.createdAtUtc) : Number.NaN;
    return !Number.isFinite(createdMs) || Date.now() - createdMs > REGISTRY_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

async function withRegistryLock<T>(cwd: string, run: (registryFile: string) => Promise<T>): Promise<T> {
  const lockDir = registryLockDir(cwd);
  const registryFile = registryPath(cwd);
  await mkdir(backgroundDir(cwd), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lockDir);
      await writeJson(join(lockDir, "owner.json"), { pid: process.pid, createdAtUtc: new Date().toISOString() });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isLockStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for PiBackground registry lock");
      await sleep(100);
    }
  }

  try {
    return await run(registryFile);
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function registerTaskStart(task: BgTask): Promise<void> {
  await withRegistryLock(task.cwd, async (file) => {
    const registry = reapStaleRegistryTasks(await readRegistry(file));
    const duplicate = registry.tasks.find((entry) => entry.state === "running" && entry.scope === task.scope && entry.id !== task.id);
    if (duplicate) {
      throw new Error(`Background task already running for scope "${task.scope}": ${duplicate.id} (${duplicate.name})`);
    }
    const next: BgRegistry = {
      version: 1,
      updatedAtUtc: new Date().toISOString(),
      tasks: [...registry.tasks.filter((entry) => entry.id !== task.id), task],
    };
    await writeJsonAtomic(file, next);
  });
}

async function updateTaskInRegistry(task: BgTask): Promise<void> {
  await withRegistryLock(task.cwd, async (file) => {
    const registry = reapStaleRegistryTasks(await readRegistry(file));
    const next: BgRegistry = {
      version: 1,
      updatedAtUtc: new Date().toISOString(),
      tasks: registry.tasks.map((entry) => entry.id === task.id ? task : entry),
    };
    if (!next.tasks.some((entry) => entry.id === task.id)) next.tasks.push(task);
    await writeJsonAtomic(file, next);
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function completionMessage(task: BgTask): string {
  const status = task.state;
  const outcome = status === "completed" ? "completed" : `${status}${task.error ? `: ${task.error}` : ""}`;
  return [
    "<background-pi-task>",
    `TaskId: ${task.id}`,
    `Name: ${task.name}`,
    `Status: ${outcome}`,
    `OriginSurface: ${task.origin.surface}`,
    `OriginRequestId: ${task.origin.requestId ?? ""}`,
    `ReplyExpected: ${task.origin.replyExpected ? "yes" : "no"}`,
    `ReplyPolicy: ${task.origin.replyPolicy}`,
    `OutputPath: ${task.outputPath}`,
    `MetadataPath: ${task.metadataPath}`,
    "",
    "Message:",
    "A background Pi task reached terminal state. Read the output path if the result is needed.",
    "</background-pi-task>",
  ].join("\n");
}

function sendCompletionFollowUp(pi: ExtensionAPI, task: BgTask): void {
  try {
    void Promise.resolve(pi.sendMessage(
      { customType: "background-pi-task", content: completionMessage(task), display: true, details: task },
      { deliverAs: "followUp", triggerTurn: true },
    )).catch(() => undefined);
  } catch {
    // The parent session may have reloaded/replaced its extension context while a
    // child was still running. Metadata/registry are already durable; never crash
    // Pi just because the old runtime can no longer inject a follow-up message.
  }
}

async function startBackgroundPi(params: BgStartParams, ctx: ExtensionContext, pi: ExtensionAPI): Promise<BgTask> {
  const id = makeId();
  const runtimeDir = join(backgroundDir(ctx.cwd), `session-${process.pid}`);
  await mkdir(runtimeDir, { recursive: true });

  const safeName = sanitizePathSegment(params.name);
  const scope = normalizeTaskScope(params.name);
  const promptPath = join(runtimeDir, `${id}-${safeName}.prompt.md`);
  const outputPath = join(runtimeDir, `${id}.output.md`);
  const metadataPath = join(runtimeDir, `${id}.json`);

  const childPrompt = `${params.prompt.trim()}\n\n---\nBackground task instructions:\n- You are a background Pi subagent.\n- Work independently and return a concise final result.\n- The parent task registry has already recorded where the spawning request came from; do not infer, choose, or mention reply destinations unless the task itself explicitly asks for origin analysis.\n- Do not send WhatsApp/Telegram messages, call bridge endpoints, or rely on inbound push ports. Main owns all outward replies and follow-up decisions.\n- If you change files, clearly list changed paths and validation performed.\n`;
  await writeFile(promptPath, childPrompt, "utf8");

  const args = [
    "--print",
    "--session-id",
    id,
    "--name",
    `BG: ${params.name}`,
    "--exclude-tools",
    CHILD_DENIED_TOOLS.join(","),
  ];
  if (params.provider) args.push("--provider", params.provider);
  if (params.model) args.push("--model", params.model);
  if (params.thinking) args.push("--thinking", params.thinking);
  args.push(`@${promptPath}`);

  const env = childEnv(process.env);
  const origin = detectOriginFromContext(ctx);

  const task: BgTask = {
    id,
    name: params.name,
    scope,
    origin,
    state: "running",
    cwd: ctx.cwd,
    promptPath,
    outputPath,
    metadataPath,
    startedAtUtc: new Date().toISOString(),
  };
  tasks.set(id, task);
  await registerTaskStart(task);
  await writeJson(metadataPath, task);

  const output = createWriteStream(outputPath, { flags: "a", encoding: "utf8" });
  const child = spawn("pi", args, {
    cwd: ctx.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
  });

  task.pid = child.pid;
  await writeJson(metadataPath, task);
  await updateTaskInRegistry(task).catch(() => undefined);

  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });

  let timeout: NodeJS.Timeout | undefined;
  if (params.timeoutSeconds && Number.isFinite(params.timeoutSeconds) && params.timeoutSeconds > 0) {
    timeout = setTimeout(() => {
      if (task.state !== "running") return;
      task.state = "killed";
      task.error = `Timed out after ${Math.floor(params.timeoutSeconds!)} seconds`;
      try { child.kill(); } catch { /* noop */ }
    }, Math.floor(params.timeoutSeconds) * 1000);
  }

  child.on("error", async (error) => {
    task.state = "failed";
    task.error = error.message;
    task.completedAtUtc = new Date().toISOString();
    output.write(`\n[spawn error: ${error.message}]\n`);
    output.end();
    await writeJson(metadataPath, task).catch(() => undefined);
    await updateTaskInRegistry(task).catch(() => undefined);
    sendCompletionFollowUp(pi, task);
  });

  child.on("close", async (code, signal) => {
    if (timeout) clearTimeout(timeout);
    if (task.state === "running") task.state = code === 0 ? "completed" : "failed";
    task.exitCode = code;
    task.signal = signal;
    if (task.state === "failed" && !task.error) task.error = `Exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
    task.completedAtUtc = new Date().toISOString();
    output.end();
    await writeJson(metadataPath, task).catch(() => undefined);
    await updateTaskInRegistry(task).catch(() => undefined);
    sendCompletionFollowUp(pi, task);
  });

  return task;
}

export default function piBackground(pi: ExtensionAPI): void {
  if (isBackgroundChild()) {
    pi.on("session_start", async (_event, ctx) => {
      currentCtx = ctx;
      pi.setActiveTools(withoutDeniedTools(pi.getActiveTools()));
    });

    pi.on("tool_call", async (event) => {
      const reason = backgroundChildBlockReason(event.toolName, event.input);
      if (reason) return { block: true, terminate: true, reason };
    });
  } else {
    pi.on("session_start", async (_event, ctx) => {
      currentCtx = ctx;
    });
  }

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
  });

  pi.registerTool({
    name: "bg_start",
    label: "Background Pi Start",
    description: "Start one isolated background Pi subagent and return immediately. bg_start automatically records durable origin metadata for the spawning request (surface, request id/correlation, reply expectation/policy) in task metadata and the project registry. Workers never choose destinations or send external messages; Main reads the result, verifies it, and decides any follow-up.",
    promptSnippet: "Start isolated background tasks with durable origin tracking; Main owns all outward follow-up decisions.",
    promptGuidelines: [
      "Use bg_start for focused long-running work; include complete task instructions, scope limits, and validation requirements in the prompt.",
      "bg_start automatically records where the spawning request came from. Do not put recipient/chat IDs or guessed reply destinations in worker prompts.",
      "Background workers must not send WhatsApp/Telegram messages, call bridge endpoints, or spawn more background tasks. Main owns external communication.",
      "If bg_start returns ReplyExpected: yes, Main should later read the completion metadata/output, verify the result, and decide whether/how to follow up.",
      "Origin tracking is provenance only. It does not guarantee delayed Telegram/WhatsApp delivery or mean raw worker output was reported to the user.",
    ],
    parameters: BgStartParams,
    async execute(_toolCallId, params: BgStartParams, _signal, _onUpdate, ctx) {
      const effectiveCtx = ctx ?? currentCtx;
      if (!effectiveCtx) throw new Error("No active Pi extension context");
      const task = await startBackgroundPi(params, effectiveCtx, pi);
      return textResult([
        `Started background Pi task ${task.id}`,
        `Name: ${task.name}`,
        `PID: ${task.pid ?? "unknown"}`,
        `Origin: ${task.origin.surface}${task.origin.requestId ? ` (${task.origin.requestId})` : ""}`,
        `ReplyExpected: ${task.origin.replyExpected ? "yes" : "no"}`,
        `Output: ${task.outputPath}`,
        `Metadata: ${task.metadataPath}`,
      ].join("\n"), { task });
    },
  });
}
