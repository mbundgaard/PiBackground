import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

assert.match(source, /durable origin tracking/i, "bg_start should advertise durable origin tracking");
assert.match(source, /Workers never choose destinations/i, "bg_start description should state workers do not choose destinations");
assert.match(source, /Origin tracking is provenance only/i, "guidelines should state origin tracking is not delivery");
assert.match(source, /ReplyExpected: yes/i, "guidelines should explain ReplyExpected semantics");
assert.match(source, /parent task registry has already recorded/i, "child prompt should tell workers origin is already recorded");
assert.match(source, /Main owns all outward replies/i, "child prompt should keep external communication with Main");
assert.match(source, /registerRuntime/i, "completion delivery should use the session-bound inbox runtime");
assert.match(source, /old runtime can no longer inject a follow-up message/i, "guard should document stale runtime reload safety");

console.log("PiBackground self-documenting smoke test passed");
