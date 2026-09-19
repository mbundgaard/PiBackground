import assert from "node:assert/strict";
import { normalizeTaskScope, reapStaleRegistryTasks } from "../src/index.ts";

assert.equal(normalizeTaskScope(" Monarch all episodes request "), "monarch_all_episodes_request");
assert.equal(normalizeTaskScope("///"), "task");

const now = Date.parse("2026-09-18T20:00:00.000Z");
const freshStarted = new Date(now - 30_000).toISOString();
const oldStarted = new Date(now - 60 * 60_000).toISOString();
const origin = {
  surface: "pi-console" as const,
  sessionId: "test-session",
  spawnedAtUtc: freshStarted,
  replyExpected: false,
  replyPolicy: "none" as const,
  correlation: {},
};

const registry = {
  version: 1 as const,
  updatedAtUtc: new Date(now).toISOString(),
  tasks: [
    {
      id: "dead-pid",
      name: "Dead PID",
      scope: "dead_pid",
      origin,
      state: "running" as const,
      cwd: "C:/tmp/project",
      pid: 123456789,
      promptPath: "prompt",
      outputPath: "output",
      metadataPath: "meta",
      startedAtUtc: freshStarted,
    },
    {
      id: "missing-pid-old",
      name: "Missing PID Old",
      scope: "missing_pid_old",
      origin,
      state: "running" as const,
      cwd: "C:/tmp/project",
      promptPath: "prompt",
      outputPath: "output",
      metadataPath: "meta",
      startedAtUtc: oldStarted,
    },
    {
      id: "missing-pid-fresh",
      name: "Missing PID Fresh",
      scope: "missing_pid_fresh",
      origin,
      state: "running" as const,
      cwd: "C:/tmp/project",
      promptPath: "prompt",
      outputPath: "output",
      metadataPath: "meta",
      startedAtUtc: freshStarted,
    },
    {
      id: "live-pid",
      name: "Live PID",
      scope: "live_pid",
      origin,
      state: "running" as const,
      cwd: "C:/tmp/project",
      pid: 42,
      promptPath: "prompt",
      outputPath: "output",
      metadataPath: "meta",
      startedAtUtc: oldStarted,
    },
  ],
};

const reaped = reapStaleRegistryTasks(registry, now, (pid) => pid === 42);
const byId = new Map(reaped.tasks.map((task) => [task.id, task]));

assert.equal(byId.get("dead-pid")?.state, "stale", "dead PID task should be reaped");
assert.match(byId.get("dead-pid")?.error ?? "", /PID 123456789 is not alive/);
assert.equal(byId.get("missing-pid-old")?.state, "stale", "old no-PID task should be reaped");
assert.match(byId.get("missing-pid-old")?.error ?? "", /no PID was recorded/);
assert.equal(byId.get("missing-pid-fresh")?.state, "running", "fresh no-PID task should remain running");
assert.equal(byId.get("live-pid")?.state, "running", "live PID task should remain running");

console.log("PiBackground registry smoke test passed");
