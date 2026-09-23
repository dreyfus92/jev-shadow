import { test } from "node:test";
import assert from "node:assert/strict";
import { triage } from "../src/rules.js";
import { claude } from "../src/hosts/claude.js";
import { preBash } from "./helpers.js";

/** Each jev-axi gap from the research, plus the routine cases that must stay local. */
const CASES: readonly [command: string, expected: "routine" | "judge"][] = [
  ["ls & rm -rf ~", "judge"],
  ["sed -Ei 's/a/b/' src/x.ts", "judge"],
  ["sed -n 's/a/b/w /Users/me/.zshrc' f", "judge"],
  ["sort -o ~/.bashrc names.txt", "judge"],
  ["find . -fprintf /tmp/x %p", "judge"],
  ["git diff --output=/etc/hosts", "judge"],
  ["git -c core.pager='rm -rf ~' log", "judge"],
  ["cd / && rm -rf tmp", "judge"],
  ["rm -rf $DIR", "judge"],
  ["echo $(cat ~/.ssh/id_rsa)", "judge"],
  ["ls -la && git status && npm test", "routine"],
  ["rm -rf node_modules dist", "routine"],
  ["cargo fmt --check", "routine"],
  ["grep -rn TODO src 2>/dev/null | wc -l", "routine"],
];

for (const [command, expected] of CASES) {
  test(`${expected}: ${command}`, () => {
    const event = claude.parse(preBash(command), { CLAUDE_PROJECT_DIR: "/p" });
    assert.ok(event.kind === "attempt");
    assert.equal(triage(event.action, event.ctx).kind, expected);
  });
}
