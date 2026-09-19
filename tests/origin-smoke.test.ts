import assert from "node:assert/strict";
import { detectOriginFromText } from "../src/index.ts";

const options = { sessionId: "session-1", spawnedAtUtc: "2026-09-18T20:00:00.000Z" };

const telegram = detectOriginFromText(`
[Message from Telegram. Public progress...]
Do a long task

[Pi Telegram request: abc-123]
`, options);
assert.equal(telegram.surface, "telegram");
assert.equal(telegram.requestId, "abc-123");
assert.equal(telegram.replyExpected, true);
assert.equal(telegram.replyPolicy, "main-review");
assert.equal(telegram.correlation.telegramRequestId, "abc-123");
assert.equal(telegram.sessionId, "session-1");

const whatsappRequired = detectOriginFromText(`
[from-whatsapp]
MessageId: wamid.42
ChatId: 120363@g.us
SenderId: 451234@c.us
ReplyMode: required
Message:
Flex, find this later
`, options);
assert.equal(whatsappRequired.surface, "whatsapp");
assert.equal(whatsappRequired.requestId, "wamid.42");
assert.equal(whatsappRequired.replyExpected, true);
assert.equal(whatsappRequired.replyPolicy, "main-review");
assert.equal(whatsappRequired.correlation.senderId, "451234@c.us");

const whatsappOptional = detectOriginFromText(`
[from-whatsapp]
MessageId: wamid.43
ReplyMode: optional
`, options);
assert.equal(whatsappOptional.surface, "whatsapp");
assert.equal(whatsappOptional.replyExpected, false);
assert.equal(whatsappOptional.replyPolicy, "none");

const scheduler = detectOriginFromText(`
[from-scheduler]
Job: flex-heartbeat
JobId: job_123
Message:
Heartbeat
`, options);
assert.equal(scheduler.surface, "scheduler");
assert.equal(scheduler.requestId, "job_123");
assert.equal(scheduler.replyExpected, false);
assert.equal(scheduler.correlation.schedulerJob, "flex-heartbeat");

const putio = detectOriginFromText(`
[from-putio-downloader]
Event: putio_item_ready
PutioFileId: 987
`, options);
assert.equal(putio.surface, "putio-downloader");
assert.equal(putio.requestId, "987");
assert.equal(putio.correlation.event, "putio_item_ready");

const consoleOrigin = detectOriginFromText("Please run a background audit", options);
assert.equal(consoleOrigin.surface, "pi-console");
assert.equal(consoleOrigin.replyExpected, false);
assert.equal(consoleOrigin.replyPolicy, "none");

const unknown = detectOriginFromText("", options);
assert.equal(unknown.surface, "unknown");

console.log("PiBackground origin smoke test passed");
