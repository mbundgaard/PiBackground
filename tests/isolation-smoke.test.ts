import assert from "node:assert/strict";
import {
  CHILD_DENIED_TOOLS,
  CHILD_ENV_FLAG,
  backgroundChildBlockReason,
  childEnv,
  withoutDeniedTools,
} from "../src/index.ts";

const activeTools = [
  "read",
  "bash",
  "write",
  "whatsapp_send_message",
  "whatsapp_send_image",
  "whatsapp_set_busy",
  "telegram_send_file",
  "telegram_start",
  "telegram_enable",
  "telegram_release",
  "telegram_remove_bot",
  "bg_start",
];

const filteredTools = withoutDeniedTools(activeTools);
for (const deniedTool of CHILD_DENIED_TOOLS) {
  assert.equal(filteredTools.includes(deniedTool), false, `${deniedTool} should be removed from active child tools`);
}
assert.deepEqual(filteredTools, ["read", "bash", "write"], "safe non-outbound tools should remain active");

for (const deniedTool of CHILD_DENIED_TOOLS) {
  assert.match(
    backgroundChildBlockReason(deniedTool, {}),
    /blocks outward\/recursive tool/,
    `${deniedTool} should be hard-blocked if invoked directly`,
  );
}

assert.match(
  backgroundChildBlockReason("multi_tool_use.parallel", {
    tool_uses: [{ recipient_name: "functions.whatsapp_send_message", parameters: { text: "hej" } }],
  }),
  /blocks nested outward\/recursive tool: whatsapp_send_message/,
  "nested outbound wrapper calls should be blocked",
);

assert.match(
  backgroundChildBlockReason("bash", {
    command: "curl http://127.0.0.1:3000/whatsapp/send-message -d '{\"text\":\"hej\"}'",
  }),
  /blocks bridge-send shell command/,
  "obvious local WhatsApp bridge shell sends should be blocked",
);

assert.match(
  backgroundChildBlockReason("powershell", {
    command: "Invoke-RestMethod https://api.telegram.org/botSECRET/sendMessage -Body @{chat_id=1;text='x'}",
  }),
  /blocks bridge-send shell command/,
  "obvious Telegram shell sends should be blocked",
);

assert.equal(
  backgroundChildBlockReason("bash", { command: "npm test" }),
  undefined,
  "ordinary shell commands should not be blocked",
);

assert.equal(
  backgroundChildBlockReason("read", { path: "src/index.ts" }),
  undefined,
  "ordinary non-outbound tools should not be blocked",
);

const env = childEnv({
  PATH: "keep-me",
  PI_WHATSAPP_DEFAULT_CHAT_ID: "drop-me",
  WHATSAPP_BRIDGE_URL: "drop-me",
  TELEGRAM_BOT_TOKEN: "drop-me",
  PI_SESSION_PUSH_URL: "drop-me",
  SESSION_PUSH_PORT: "drop-me",
});

assert.equal(env.PATH, "keep-me", "unrelated env should be preserved");
assert.equal(env.PI_WHATSAPP_DEFAULT_CHAT_ID, undefined, "WhatsApp env should be stripped");
assert.equal(env.WHATSAPP_BRIDGE_URL, undefined, "WhatsApp bridge env should be stripped");
assert.equal(env.TELEGRAM_BOT_TOKEN, undefined, "Telegram env should be stripped");
assert.equal(env.PI_SESSION_PUSH_URL, undefined, "session-push env should be stripped");
assert.equal(env.SESSION_PUSH_PORT, undefined, "session-push env should be stripped");
assert.equal(env.PI_SESSION_PUSH_DISABLED, "1", "session-push should be disabled");
assert.equal(env[CHILD_ENV_FLAG], "1", "background child flag should be set");
assert.equal(env.TELEGRAMPI_DISABLED, "1", "Telegram Pi integration should be disabled");

console.log("PiBackground isolation smoke test passed");
