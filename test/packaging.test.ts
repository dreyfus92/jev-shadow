import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GATE_BUDGET_MAX, GATE_HOOK_TIMEOUT_S } from "../src/config.js";

test("hooks.json gate timeout leaves a second of margin over the Jev budget", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8"));
  const gate = hooks.hooks.PreToolUse[0].hooks.find((h: { args: string[] }) => h.args.includes("gate"));
  assert.equal(gate.timeout, GATE_HOOK_TIMEOUT_S);
  assert.ok(GATE_HOOK_TIMEOUT_S * 1000 >= GATE_BUDGET_MAX + 1000);
});

test("every observer hook is async, every matcher is anchored, and every entry is exec-form node", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8"));
  const events = Object.keys(hooks.hooks);
  assert.deepEqual(events, ["PreToolUse", "PermissionDenied", "PostToolUse", "PostToolUseFailure"]);
  for (const groups of Object.values<{ matcher: string; hooks: { type: string; command: string; args: string[]; async?: boolean; timeout?: number }[] }[]>(hooks.hooks)) {
    for (const group of groups) {
      assert.match(group.matcher, /^\^\(.*\)\$$/, "unanchored `Write` also matches `TodoWrite`");
      for (const h of group.hooks) {
        assert.equal(h.type, "command");
        assert.equal(h.command, "node", "exec form: the command is `node`, arguments travel in `args`");
        assert.deepEqual(h.args.slice(0, 1), ["${CLAUDE_PLUGIN_ROOT}/bin/jev-shadow"]);
        assert.deepEqual(h.args.slice(-2), ["--data", "${CLAUDE_PLUGIN_DATA}"]);
        if (h.args.includes("observe")) assert.equal(h.async, true);
        if (h.args.includes("gate")) assert.equal(h.async, undefined, "the gate must be synchronous to print a decision");
      }
    }
  }
});

test("the gate is registered on PreToolUse only, once", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8"));
  const gates = Object.entries<{ hooks: { args: string[] }[] }[]>(hooks.hooks)
    .flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.filter((h) => h.args.includes("gate")).map(() => event)));
  assert.deepEqual(gates, ["PreToolUse"]);
});
