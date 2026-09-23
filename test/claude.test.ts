import { test } from "node:test";
import assert from "node:assert/strict";
import { claude } from "../src/hosts/claude.js";
import type { Decision } from "../src/core.js";
import type { Probability } from "../src/jev.js";
import { fixture } from "./helpers.js";

const parse = (rel: string, env: Record<string, string> = {}) => claude.parse(fixture(rel), env);
const wire = (overrides: Record<string, unknown>): string =>
  JSON.stringify({ ...(JSON.parse(fixture("events/pre-bash.json")) as Record<string, unknown>), ...overrides });

test("PreToolUse Bash fixtures parse to shell attempts with the session, tool use id and permission mode", () => {
  const event = parse("claude/pre-tool-use.bash.rm-home.json");
  assert.ok(event.kind === "attempt");
  assert.equal(event.ctx.session, "4f1c2a9e-7d1b-4e57-9a0c-2b8f6d3e1a10");
  assert.equal(event.ctx.toolUseId, "toolu_01RmHome000000000000000");
  assert.equal(event.ctx.permissionMode, "default");
  assert.equal(event.ctx.agentId, null);
  assert.deepEqual(event.action, { kind: "shell", dialect: "posix", command: "ls & rm -rf ~" });
  assert.equal(event.ctx.projectRoot, "/p");
  const auto = parse("events/pre-bash.json", { CLAUDE_PROJECT_DIR: "/root" });
  assert.ok(auto.kind === "attempt" && auto.ctx.permissionMode === "auto" && auto.ctx.projectRoot === "/root" && auto.ctx.cwd === "/Users/x/Documents/e18e/module-replacements");
});

test("PermissionDenied and PostToolUse fixtures parse to labels keyed by the same tool use id", () => {
  const denied = parse("events/denied-bash.json");
  assert.deepEqual(denied.kind === "denied" && [denied.ctx.toolUseId, denied.reason], ["toolu_01ABC123", { kind: "rule", label: "Irreversible Local Destruction" }]);
  const ran = parse("events/post-write.json");
  assert.deepEqual(ran.kind === "ran" && [ran.ctx.toolUseId, ran.ok, ran.ctx.tool], ["toolu_01DEF456", true, "Write"]);
  const failed = claude.parse(wire({ hook_event_name: "PostToolUseFailure", error: "Exit code 1" }), {});
  assert.deepEqual(failed.kind === "ran" && failed.ok, false);
});

test("the four denial reason forms", () => {
  const reason = (text: string) => { const e = claude.parse(wire({ hook_event_name: "PermissionDenied", reason: text }), {}); return e.kind === "denied" ? e.reason : e; };
  assert.deepEqual(reason("[Data Exfiltration]"), { kind: "rule", label: "Data Exfiltration" });
  assert.deepEqual(reason("[Production Deploy] extra text"), { kind: "rule", label: "Production Deploy" });
  assert.deepEqual(reason("Auto mode could not evaluate this action and is blocking it for safety. Try again."), { kind: "no_verdict" });
  assert.deepEqual(reason("Classifier unavailable"), { kind: "unavailable" });
  assert.deepEqual(reason("some other reason"), { kind: "other", text: "some other reason" });
});

test("write tools map to a write action with the edited content; Windows paths become forward-slash", () => {
  const w = claude.parse(wire({ tool_name: "Write", tool_input: { file_path: "C:\\proj\\src\\a.ts", content: "x" } }), {});
  assert.deepEqual(w.kind === "attempt" && w.action, { kind: "write", path: "C:/proj/src/a.ts", content: "x" });
  const e = claude.parse(wire({ tool_name: "Edit", tool_input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } }), {});
  assert.deepEqual(e.kind === "attempt" && e.action, { kind: "write", path: "/p/a.ts", content: "b" });
  const m = claude.parse(wire({ tool_name: "MultiEdit", tool_input: { file_path: "/p/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } }), {});
  assert.deepEqual(m.kind === "attempt" && m.action, { kind: "write", path: "/p/a.ts", content: "b\nd" });
  const n = claude.parse(wire({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/p/n.ipynb", new_source: "print(1)" } }), {});
  assert.deepEqual(n.kind === "attempt" && n.action, { kind: "write", path: "/p/n.ipynb", content: "print(1)" });
  assert.equal(claude.parse(wire({ tool_name: "Write", tool_input: { content: "x" } }), {}).kind, "unsupported");
});

test("WebFetch, PowerShell and MCP tools map to their actions; MCP input is the serialized tool_input", () => {
  const f = claude.parse(wire({ tool_name: "WebFetch", tool_input: { url: "https://x", prompt: "summarize" } }), {});
  assert.deepEqual(f.kind === "attempt" && f.action, { kind: "fetch", url: "https://x", prompt: "summarize" });
  const p = claude.parse(wire({ tool_name: "PowerShell", tool_input: { command: "Get-ChildItem" } }), {});
  assert.deepEqual(p.kind === "attempt" && p.action, { kind: "shell", dialect: "powershell", command: "Get-ChildItem" });
  const m = claude.parse(wire({ tool_name: "mcp__github__create_issue", tool_input: { title: "t" }, mcp_server: { name: "github", source: "user" } }), {});
  assert.deepEqual(m.kind === "attempt" && m.action, { kind: "mcp", server: "github", input: '{"title":"t"}' });
  const noServer = claude.parse(wire({ tool_name: "mcp__slack__post", tool_input: {} }), {});
  assert.equal(noServer.kind === "attempt" && noServer.action.kind === "mcp" && noServer.action.server, "slack");
});

test("unmodeled tools, unknown events, absent permission_mode and subagent ids", () => {
  assert.equal(claude.parse(wire({ tool_name: "TodoWrite" }), {}).kind, "unsupported");
  assert.equal(claude.parse(wire({ hook_event_name: "Stop" }), {}).kind, "unsupported");
  assert.equal(claude.parse("{", {}).kind, "unsupported");
  assert.equal(claude.parse("[]", {}).kind, "unsupported");
  const e = claude.parse(wire({ permission_mode: undefined, agent_id: "agent-7" }), {});
  assert.ok(e.kind === "attempt" && e.ctx.permissionMode === "unknown" && e.ctx.agentId === "agent-7");
  const weird = claude.parse(wire({ permission_mode: "manual" }), {});
  assert.ok(weird.kind === "attempt" && weird.ctx.permissionMode === "unknown");
});

test("render: allow prints nothing; ask and deny print hookSpecificOutput with a reason and no tool input", () => {
  assert.equal(claude.render({ effect: "allow", basis: { kind: "rule", rule: "read.ls" } }), "");
  const deny: Decision = { effect: "deny", basis: { kind: "hazard", hazard: "destructive", p: 0.97 as Probability, risk: 1.94 } };
  const out = JSON.parse(claude.render(deny)) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput["hookEventName"], "PreToolUse");
  assert.equal(out.hookSpecificOutput["permissionDecision"], "deny");
  assert.match(out.hookSpecificOutput["permissionDecisionReason"] ?? "", /^jev-shadow: likely irreversible deletion or overwrite of data \(p=0\.97, risk 1\.9 of 2\)\. Blocked\./);
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  const ask = JSON.parse(claude.render({ effect: "ask", basis: { kind: "jev_failed", error: { kind: "failed", error: { kind: "firewall" }, latencyMs: 3 as never }, onError: "ask" } })) as { hookSpecificOutput: Record<string, string> };
  assert.equal(ask.hookSpecificOutput["permissionDecision"], "ask");
  assert.match(ask.hookSpecificOutput["permissionDecisionReason"] ?? "", /failed \(firewall\).*Needs explicit user approval/);
});

test("apiKey reads the plugin option and wraps it; absent or blank is null", () => {
  assert.equal(claude.apiKey({})?.reveal(), undefined);
  assert.equal(claude.apiKey({ CLAUDE_PLUGIN_OPTION_JEV_API_KEY: " " }), null);
  assert.equal(claude.apiKey({ CLAUDE_PLUGIN_OPTION_JEV_API_KEY: "k" })?.reveal(), "k");
});
