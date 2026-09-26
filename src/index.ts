import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import lockfile from "proper-lockfile";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { launchWorker, type WorkerResult } from "./worker.js";
import { readSchedules, type Schedule } from "./schedules.js";
import { registerRuntime } from "./runtime.js";

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

export interface BgTask {
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
  resultPath?: string;
  stderrPath?: string;
  scheduleId?: string;
  acknowledgedAtUtc?: string;
}

interface BgRegistry {
  version: 1;
  updatedAtUtc: string;
  tasks: BgTask[];
}

const REGISTRY_FILE_NAME = "registry.json";
const lockGuard = new AsyncLocalStorage<() => void>();
const REGISTRY_TASK_WITHOUT_PID_STALE_MS = 10 * 60_000;

export const CHILD_ENV_FLAG = "PI_BACKGROUND_CHILD";

export const CHILD_DENIED_TOOLS = [
  // Outward/public messaging belongs to the parent session only.
  "whatsapp_send_message",
  "whatsapp_send_image",
  "whatsapp_set_busy",
  "telegram_send_file",
  "telegram_send",
  "telegram_send_photo",
  "telegram_complete_setup",
  "telegram_start",
  "telegram_enable",
  "telegram_release",
  "telegram_remove_bot",
  // Children must not spawn more children unless explicitly reworked later.
  "bg_start",
  "bg_inbox",
  "bg_schedule_create",
  "bg_schedule_list",
  "bg_schedule_delete",
  "bg_schedule_enable",
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
  name: Type.String({ maxLength: 200, description: "Short human-readable name for this background Pi task." }),
  prompt: Type.String({ maxLength: 32000, description: "Complete prompt/task brief for the background Pi subagent." }),
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    lockGuard.getStore()?.();
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }).catch(() => undefined); }
}

async function readRegistry(path: string): Promise<BgRegistry> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<BgRegistry>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || parsed.tasks.some(task =>
      !task || typeof task.id !== "string" || !task.origin || !["running", "completed", "failed", "killed", "stale"].includes(task.state))) {
      throw new Error("Invalid Pi Background registry; refusing to overwrite");
    }
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

export async function withRegistryLock<T>(cwd: string, run: (registryFile: string) => Promise<T>): Promise<T> {
  await mkdir(backgroundDir(cwd), { recursive: true });
  let compromised: Error | undefined;
  const release = await lockfile.lock(backgroundDir(cwd), {
    lockfilePath: join(backgroundDir(cwd), ".state.lock"),
    stale: 120_000, update: 10_000,
    retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
    onCompromised: error => { compromised = error; },
  });
  const check = () => { if (compromised) throw compromised; };
  try {
    return await lockGuard.run(check, async () => {
      const value = await run(registryPath(cwd));
      check();
      return value;
    });
  } finally { await release().catch(error => { if (!compromised) throw error; }); }
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
      tasks: registry.tasks.map((entry) => entry.id === task.id ? { ...task, acknowledgedAtUtc: entry.acknowledgedAtUtc } : entry),
    };
    if (!next.tasks.some((entry) => entry.id === task.id)) next.tasks.push(task);
    await writeJsonAtomic(file, next);
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export async function startBackgroundPi(
  params: BgStartParams, ctx: ExtensionContext, alive: () => boolean = () => true,
  scheduleId?: string, launch: typeof launchWorker = launchWorker,
): Promise<BgTask> {
  if (isBackgroundChild()) throw new Error("Background children cannot start workers");
  if (!params.name.trim() || !params.prompt.trim()) throw new Error("Name and prompt are required");
  if (params.timeoutSeconds !== undefined && (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds <= 0 || params.timeoutSeconds > 2_147_483)) {
    throw new Error("timeoutSeconds must be positive and at most 2147483");
  }
  const ownerSessionId = ctx.sessionManager.getSessionId();
  if (!ownerSessionId) throw new Error("A session ID is required");
  const id = makeId();
  const runtimeDir = join(backgroundDir(ctx.cwd), `session-${process.pid}`);
  await mkdir(runtimeDir, { recursive: true });

  const safeName = sanitizePathSegment(params.name);
  const scope = scheduleId ? `schedule:${ownerSessionId}:${scheduleId}` : normalizeTaskScope(params.name);
  const promptPath = join(runtimeDir, `${id}-${safeName}.prompt.md`);
  const outputPath = join(runtimeDir, `${id}.events.jsonl`);
  const stderrPath = join(runtimeDir, `${id}.stderr.log`);
  const resultPath = join(runtimeDir, `${id}.result.json`);
  const metadataPath = join(runtimeDir, `${id}.json`);

  const childPrompt = `${params.prompt.trim()}\n\n---\nBackground task instructions:\n- You are a background Pi subagent.\n- Work independently and return a concise final result.\n- The parent task registry has already recorded where the spawning request came from; do not infer, choose, or mention reply destinations unless the task itself explicitly asks for origin analysis.\n- Do not send WhatsApp/Telegram messages, call bridge endpoints, or rely on inbound push ports. Main owns all outward replies and follow-up decisions.\n- If you change files, clearly list changed paths and validation performed.\n`;
  await writeFile(promptPath, childPrompt, { encoding: "utf8", mode: 0o600 });

  const args = [
    join(getPackageDir(), "dist", "cli.js"),
    "--print",
    "--mode", "json",
    "--no-session",
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
  const origin: BgTaskOrigin = scheduleId ? {
    surface: "scheduler", sessionId: ownerSessionId, spawnedAtUtc: new Date().toISOString(),
    requestId: scheduleId, replyExpected: false, replyPolicy: "main-review", correlation: { scheduleId },
  } : detectOriginFromContext(ctx);

  const task: BgTask = {
    id,
    name: params.name,
    scope,
    origin,
    state: "running",
    cwd: ctx.cwd,
    promptPath,
    outputPath,
    metadataPath, resultPath, stderrPath, scheduleId,
    startedAtUtc: new Date().toISOString(),
  };
  await registerTaskStart(task);
  const finish = async (result: WorkerResult) => {
    task.state = result.status;
    task.error = result.error;
    task.exitCode = result.exitCode;
    task.signal = result.signal;
    task.completedAtUtc = new Date().toISOString();
    // Result first: recovery can reconstruct registry completion after a crash.
    await writeJsonAtomic(resultPath, { version: 1, taskId: id, ownerSessionId, completedAtUtc: task.completedAtUtc, ...result });
    await writeJsonAtomic(metadataPath, task);
    await updateTaskInRegistry(task);
    // No captured Pi API here: the old runtime can no longer inject a follow-up message.
    // A live, session-bound inbox poll will discover the durable completion instead.
  };
  try {
    await writeJsonAtomic(metadataPath, task);
    if (!alive()) throw new Error("Owning session is no longer active");
    const { child, completion } = launch({ command: process.execPath, args, cwd: ctx.cwd, env,
      outputPath, stderrPath, timeoutSeconds: params.timeoutSeconds });
    task.pid = child.pid;
    // Attach completion immediately, but serialize it after the PID write.
    const pidWrite = writeJsonAtomic(metadataPath, task).then(() => updateTaskInRegistry(task));
    void completion.then(async result => {
      await pidWrite.catch(() => undefined);
      await finish(result);
    }).catch(error => console.error(`Pi Background result persistence failed for ${id}: ${String(error)}`));
    await pidWrite;
  } catch (error) {
    // A PID means the worker is already running; never mark it terminal prematurely.
    if (!task.pid) await finish({ status: "failed", finalAnswer: "", error: String(error), exitCode: null, signal: null });
    throw error;
  }
  return task;
}

export async function ownedTasks(cwd: string, sessionId: string): Promise<BgTask[]> {
  return withRegistryLock(cwd, async file => {
    const original = await readRegistry(file);
    const before = JSON.stringify(original);
    const registry = reapStaleRegistryTasks(original);
    for (const task of registry.tasks) {
      if (task.origin?.sessionId !== sessionId || !task.resultPath || !["running", "stale"].includes(task.state)) continue;
      try {
        const result = await readTaskResult(task);
        task.state = result.status;
        task.error = result.error;
        task.exitCode = result.exitCode;
        task.signal = result.signal;
        task.completedAtUtc = result.completedAtUtc;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (before !== JSON.stringify(registry)) {
      registry.updatedAtUtc = new Date().toISOString();
      await writeJsonAtomic(file, registry);
    }
    return registry.tasks.filter(task => task.origin?.sessionId === sessionId);
  });
}

export async function readTaskResult(task: BgTask): Promise<WorkerResult & { completedAtUtc?: string }> {
  if (!task.resultPath) return { status: "failed", finalAnswer: "", error: "Legacy task: inspect its output log", exitCode: task.exitCode ?? null, signal: task.signal ?? null };
  const result = JSON.parse(await readFile(task.resultPath, "utf8"));
  if (result.version !== 1 || result.taskId !== task.id || result.ownerSessionId !== task.origin.sessionId
    || !["completed", "failed", "killed"].includes(result.status) || typeof result.finalAnswer !== "string") {
    throw new Error("Invalid task result identity or format");
  }
  return result;
}

export async function acknowledgeTask(cwd: string, sessionId: string, id: string): Promise<void> {
  await withRegistryLock(cwd, async file => {
    const registry = await readRegistry(file);
    const task = registry.tasks.find(t => t.id === id && t.origin?.sessionId === sessionId);
    if (!task || task.state === "running") throw new Error("No completed task with that ID belongs to this session");
    task.acknowledgedAtUtc ??= new Date().toISOString();
    await writeJsonAtomic(file, registry);
  });
}

export async function changeSchedules<T>(cwd: string, change: (schedules: Schedule[]) => T): Promise<T> {
  return withRegistryLock(cwd, async () => {
    const file = join(backgroundDir(cwd), "schedules.json");
    const schedules = await readSchedules(file);
    const before = JSON.stringify(schedules);
    const result = change(schedules);
    if (before !== JSON.stringify(schedules)) await writeJsonAtomic(file, { version: 1, schedules });
    return result;
  });
}

export default function piBackground(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined;
  const runtime = registerRuntime(pi, {
    child: isBackgroundChild(), ownedTasks, readTaskResult, acknowledgeTask, changeSchedules, startBackgroundPi,
  });
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
      const task = await startBackgroundPi(params, effectiveCtx, runtime.guard(effectiveCtx));
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
