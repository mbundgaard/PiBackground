import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ownedTasks, acknowledgeTask, changeSchedules, withRegistryLock, startBackgroundPi, readTaskResult } from "../src/index.ts";
import { createSchedule } from "../src/schedules.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-inbox-"));
  const dir = join(cwd, ".pi", "background"); await mkdir(dir, { recursive: true });
  const resultPath = join(dir, "task.result.json");
  const task = { id: "task", name: "check", scope: "check", state: "running", cwd,
    pid: process.pid, startedAtUtc: new Date().toISOString(),
    origin: { sessionId: "owner", surface: "pi-console", correlation: {}, spawnedAtUtc: new Date().toISOString(), replyExpected: false, replyPolicy: "none" },
    promptPath: "prompt", outputPath: "events", metadataPath: "metadata", resultPath };
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, updatedAtUtc: new Date().toISOString(), tasks: [task] }));
  return { cwd, dir, registryPath, resultPath, task };
}

test("result-first persistence recovers completion and acknowledgments survive reload", async () => {
  const f = await fixture();
  try {
    await writeFile(f.resultPath, JSON.stringify({ version: 1, taskId: "task", ownerSessionId: "owner", status: "completed", finalAnswer: "done", exitCode: 0, signal: null }));
    const tasks = await ownedTasks(f.cwd, "owner");
    assert.equal(tasks[0].state, "completed");
    assert.equal(JSON.parse(await readFile(f.registryPath, "utf8")).tasks[0].state, "completed");
    assert.deepEqual(await ownedTasks(f.cwd, "different"), []);
    await assert.rejects(acknowledgeTask(f.cwd, "different", "task"));
    await acknowledgeTask(f.cwd, "owner", "task");
    const first = (await ownedTasks(f.cwd, "owner"))[0].acknowledgedAtUtc;
    await acknowledgeTask(f.cwd, "owner", "task");
    assert.equal((await ownedTasks(f.cwd, "owner"))[0].acknowledgedAtUtc, first);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
});

test("corrupt or wrong-owner results fail closed without overwriting registry", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.registryPath, "utf8");
    await writeFile(f.resultPath, JSON.stringify({ version: 1, taskId: "task", ownerSessionId: "other", status: "completed", finalAnswer: "bad" }));
    await assert.rejects(ownedTasks(f.cwd, "owner"));
    assert.equal(await readFile(f.registryPath, "utf8"), before);
    await writeFile(f.registryPath, '{"version":99}');
    await assert.rejects(ownedTasks(f.cwd, "owner"));
    assert.equal(await readFile(f.registryPath, "utf8"), '{"version":99}');
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
});

test("concurrent schedule mutations are serialized without lost records", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => changeSchedules(f.cwd, schedules => {
      schedules.push(createSchedule({ name: `s${i}`, prompt: "test", target: "main", when: "+1h" }, "owner"));
    })));
    const data = JSON.parse(await readFile(join(f.dir, "schedules.json"), "utf8"));
    assert.equal(data.schedules.length, 12);
    assert.equal(new Set(data.schedules.map((s: any) => s.id)).size, 12);
    await assert.rejects(withRegistryLock(f.cwd, async () => { throw new Error("expected"); }));
    await withRegistryLock(f.cwd, async () => undefined);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
});

test("worker completion is persisted after PID registration and needs no live parent API", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-finish-"));
  try {
    let finish!: (value: any) => void;
    let alive = true;
    const ctx: any = { cwd, sessionManager: { getSessionId: () => "owner", getBranch: () => [] } };
    const launch: any = (options: any) => {
      assert.equal(options.command, process.execPath);
      assert.ok(options.args.includes("json"));
      assert.equal(options.env.PI_BACKGROUND_CHILD, "1");
      return { child: { pid: process.pid }, completion: new Promise(r => { finish = r; }) };
    };
    const task = await startBackgroundPi({ name: "test", prompt: "test" }, ctx, () => alive, undefined, launch);
    assert.equal(task.state, "running");
    alive = false;
    finish({ status: "completed", finalAnswer: "structured answer", exitCode: 0, signal: null });
    for (let i = 0; i < 100; i++) {
      const saved = await ownedTasks(cwd, "owner");
      if (saved[0].state === "completed") break;
      await new Promise(r => setTimeout(r, 10));
    }
    const saved = (await ownedTasks(cwd, "owner"))[0];
    assert.equal(saved.state, "completed");
    assert.equal((await readTaskResult(saved)).finalAnswer, "structured answer");
    // Allow the completion callback's metadata/registry write to fully drain.
    await new Promise(r => setTimeout(r, 150));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("shutdown during preparation prevents spawn and records a failed result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bg-inactive-"));
  try {
    const ctx: any = { cwd, sessionManager: { getSessionId: () => "owner", getBranch: () => [] } };
    let spawned = false;
    await assert.rejects(startBackgroundPi({ name: "test", prompt: "test" }, ctx, () => false, undefined,
      (() => { spawned = true; throw new Error("must not spawn"); }) as any));
    assert.equal(spawned, false);
    const tasks = await ownedTasks(cwd, "owner");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].state, "failed");
    assert.match((await readTaskResult(tasks[0])).error!, /no longer active/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
