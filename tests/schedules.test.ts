import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeDue, createSchedule } from "../src/schedules.ts";

const input = { name: "check", prompt: "check tests", target: "background", when: "+1m" };

test("one-shot trigger consumed once even without a successful dispatch", () => {
  const s = createSchedule(input, "owner", 0);
  assert.equal(s.nextAt, 60000);
  assert.equal(consumeDue(s, 59999), undefined);
  assert.ok(consumeDue(s, 60000));
  assert.equal(s.enabled, false);
  assert.equal(consumeDue(s, 60000), undefined);
});

test("recurrence skips backlog and keeps original phase", () => {
  const s = createSchedule({ ...input, intervalSeconds: 60 }, "owner", 0);
  assert.equal(consumeDue(s, 300000), undefined);
  assert.equal(s.nextAt, 360000);
  assert.equal(s.lastRun?.outcome, "skipped-missed");
  assert.ok(consumeDue(s, 360000));
  assert.equal(s.nextAt, 420000);
});

test("resume discards missed triggers, including those within jitter tolerance", () => {
  const once = createSchedule(input, "owner", 0);
  assert.equal(consumeDue(once, 60001, true), undefined);
  assert.equal(once.enabled, false);
  const recurring = createSchedule({ ...input, intervalSeconds: 60 }, "owner", 0);
  assert.equal(consumeDue(recurring, 60001, true), undefined);
  assert.equal(recurring.nextAt, 120000);
});

test("disabled schedules don't dispatch; future timezone dates and relative units accepted", () => {
  const s = createSchedule({ ...input, when: "2030-01-01T12:00:00+02:00" }, "owner", 0);
  assert.equal(s.nextAt, Date.parse("2030-01-01T10:00:00Z"));
  s.enabled = false;
  assert.equal(consumeDue(s, s.nextAt), undefined);
  assert.equal(createSchedule({ ...input, when: "+1h" }, "owner", 0).nextAt, 3600000);
});

test("invalid times, intervals and incompatible main options are rejected", () => {
  for (const when of ["yesterday", "+0m", "2030-01-01T12:00:00", "* * * * *"]) {
    assert.throws(() => createSchedule({ ...input, when }, "owner", 0));
  }
  for (const intervalSeconds of [0, -1, NaN, Infinity]) {
    assert.throws(() => createSchedule({ ...input, intervalSeconds }, "owner", 0));
  }
  assert.throws(() => createSchedule({ ...input, target: "main", model: "x" }, "owner", 0));
});
