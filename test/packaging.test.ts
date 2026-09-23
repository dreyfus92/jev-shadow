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

test("every observer hook is async and every matcher is anchored", () => {
  const hooks = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8"));
  for (const groups of Object.values<{ matcher: string; hooks: { args: string[]; async?: boolean }[] }[]>(hooks.hooks)) {
    for (const group of groups) {
      assert.match(group.matcher, /^\^\(.*\)\$$/, "unanchored `Write` also matches `TodoWrite`");
      for (const h of group.hooks) if (h.args.includes("observe")) assert.equal(h.async, true);
    }
  }
});
