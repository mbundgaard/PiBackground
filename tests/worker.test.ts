import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResultCollector, launchWorker } from "../src/worker.ts";

const event = (text: string, reason = "stop") => JSON.stringify({ type: "message_end", message: {
  role: "assistant", stopReason: reason,
  content: [{ type: "thinking", thinking: "private" }, { type: "text", text }],
} });

test("collector handles chunks, excludes thinking/tools, uses only last finalized answer", () => {
  const c = new ResultCollector();
  c.push('noise\n' + event("intermediate", "toolUse") + '\n');
  const final = event("final 🐱");
  for (const char of final) c.push(char);
  c.end();
  assert.equal(c.result(0, null).finalAnswer, "final 🐱");
  assert.equal(c.result(0, null).status, "completed");
  assert.equal(c.result(1, null).status, "failed");
  assert.equal(c.result(0, null, "timeout", true).status, "killed");
});

test("empty, tool-only, aborted, length and error outputs aren't successful results", () => {
  for (const reason of [undefined, "toolUse", "aborted", "length", "error"]) {
    const c = new ResultCollector();
    if (reason) c.push(event("partial", reason) + '\n');
    assert.equal(c.result(0, null).status, "failed");
  }
});

test("oversized event cannot leave a previous successful result active", () => {
  const c = new ResultCollector();
  c.push(event("old") + '\n');
  c.push('x'.repeat(c.maxLine + 1) + '\n');
  assert.equal(c.result(0, null).status, "failed");
  c.push(event("new") + '\n');
  assert.equal(c.result(0, null).finalAnswer, "new");
});

test("worker uses separate logs, captures Unicode, waits for flushed output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-worker-"));
  try {
    const outputPath = join(dir, "events.jsonl"), stderrPath = join(dir, "stderr.log");
    const script = `process.stderr.write('diagnostic'); process.stdout.write(${JSON.stringify(event("done 🐱") + '\n')});`;
    const { completion } = launchWorker({ command: process.execPath, args: ["-e", script], cwd: dir,
      env: process.env, outputPath, stderrPath });
    const result = await completion;
    assert.equal(result.status, "completed");
    assert.equal(result.finalAnswer, "done 🐱");
    assert.equal(await readFile(stderrPath, "utf8"), "diagnostic");
    assert.match(await readFile(outputPath, "utf8"), /message_end/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("spawn error then close produces one failed result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-spawn-"));
  try {
    let completions = 0;
    const worker = launchWorker({ command: join(dir, "missing-executable"), args: [], cwd: dir,
      env: process.env, outputPath: join(dir, "out"), stderrPath: join(dir, "err") });
    const result = await worker.completion.then(r => { completions++; return r; });
    assert.equal(completions, 1);
    assert.equal(result.status, "failed");
    assert.match(result.error!, /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("timeout retains running process until close and reports killed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-timeout-"));
  try {
    const { completion } = launchWorker({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: dir,
      env: process.env, outputPath: join(dir, "out"), stderrPath: join(dir, "err"), timeoutSeconds: 0.1 });
    assert.equal((await completion).status, "killed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
