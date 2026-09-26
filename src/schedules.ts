import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface Schedule {
  id: string;
  ownerSessionId: string;
  name: string;
  prompt: string;
  target: "main" | "background";
  nextAt: number;
  intervalMs?: number;
  enabled: boolean;
  timeoutSeconds?: number;
  model?: string;
  provider?: string;
  thinking?: string;
  lastRun?: { at: string; outcome: string; taskId?: string; error?: string };
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  target: string;
  when: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  model?: string;
  provider?: string;
  thinking?: string;
}

export function createSchedule(input: ScheduleInput, sessionId: string, now = Date.now()): Schedule {
  if (!input.name.trim() || !input.prompt.trim()) throw new Error("Schedule name and prompt are required");
  if (input.target !== "main" && input.target !== "background") throw new Error("Target must be main or background");
  const relative = /^\+(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(input.when);
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const nextAt = relative ? now + Number(relative[1]) * units[relative[2]]
    : /(?:Z|[+-]\d{2}:\d{2})$/.test(input.when) ? Date.parse(input.when) : NaN;
  if (!Number.isFinite(nextAt) || nextAt <= now || nextAt > 8.64e15) throw new Error("when must be a future ISO timestamp with timezone or +duration (e.g. +10m)");
  if (input.intervalSeconds !== undefined && (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 1 || input.intervalSeconds > 31_536_000)) {
    throw new Error("intervalSeconds must be between 1 and 31536000");
  }
  if (input.timeoutSeconds !== undefined && (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0 || input.timeoutSeconds > 2_147_483)) {
    throw new Error("timeoutSeconds must be positive and at most 2147483");
  }
  if (input.target === "main" && [input.timeoutSeconds, input.model, input.provider, input.thinking].some(v => v !== undefined)) {
    throw new Error("Main schedules use the current session settings; worker options are background-only");
  }
  return {
    id: `schedule_${randomUUID()}`, ownerSessionId: sessionId,
    name: input.name.trim(), prompt: input.prompt, target: input.target, nextAt,
    intervalMs: input.intervalSeconds === undefined ? undefined : input.intervalSeconds * 1000,
    enabled: true, timeoutSeconds: input.timeoutSeconds, model: input.model,
    provider: input.provider, thinking: input.thinking,
  };
}

/** Consume a trigger BEFORE attempting dispatch. Never leave execution queued. */
export function consumeDue(schedule: Schedule, now: number, missed = false): Schedule | undefined {
  if (!schedule.enabled || schedule.nextAt > now) return undefined;
  const run = { ...schedule };
  if (schedule.intervalMs) {
    schedule.nextAt += (Math.floor((now - schedule.nextAt) / schedule.intervalMs) + 1) * schedule.intervalMs;
  } else {
    schedule.enabled = false;
  }
  // Timer jitter up to 1.5s is allowed; sleep/event-loop stalls aren't catch-up runs.
  const skipped = missed || now - run.nextAt > 1500;
  schedule.lastRun = { at: new Date(now).toISOString(), outcome: skipped ? "skipped-missed" : "claimed" };
  return skipped ? undefined : run;
}

export async function readSchedules(path: string): Promise<Schedule[]> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const data = JSON.parse(text);
  if (data?.version !== 1 || !Array.isArray(data.schedules)) throw new Error("Invalid schedules file");
  const ids = new Set();
  for (const s of data.schedules) {
    if (!s || typeof s.id !== "string" || ids.has(s.id) || typeof s.ownerSessionId !== "string"
      || typeof s.name !== "string" || typeof s.prompt !== "string" || typeof s.enabled !== "boolean"
      || !["main", "background"].includes(s.target) || !Number.isFinite(s.nextAt)
      || (s.intervalMs !== undefined && (!Number.isFinite(s.intervalMs) || s.intervalMs < 1000))) {
      throw new Error("Invalid schedule record; refusing to execute");
    }
    ids.add(s.id);
  }
  return data.schedules;
}
