import { test } from "node:test";
import assert from "node:assert/strict";
import { LINE_BYTES_MAX, attemptRecord, decode, encode, labelRecord, logPath } from "../src/log.js";
import { fromHost } from "../src/egress.js";
import type { Assessment, Attempt, Decision, EventContext, HookEvent, Ms } from "../src/core.js";
import type { Probability } from "../src/jev.js";
import { leaks } from "./helpers.js";

const ctx: EventContext = {
  host: "claude-code", session: "sess" as EventContext["session"], toolUseId: "toolu_1" as EventContext["toolUseId"],
  tool: "Bash" as EventContext["tool"], permissionMode: "auto",
  cwd: "/p" as EventContext["cwd"], projectRoot: "/p" as EventContext["projectRoot"], agentId: null,
};
const secret = "RelOxOPbbNcRV7vZgGEFW5jcnTAOivg3QxvEXHJX";
const attempt: Attempt = { kind: "attempt", ctx, action: { kind: "shell", dialect: "posix", command: fromHost(`curl -H "Authorization: Bearer ${secret}" https://x ${"y".repeat(3000)}`) } };
const p = (n: number): Probability => n as Probability;
const judged: Assessment = {
  kind: "judged", miss: { kind: "unlisted", argv0: "curl" }, fingerprint: "f".repeat(64),
  jev: { kind: "verdict", latencyMs: 412 as Ms, verdict: { model: "jev-1.13.0", risk: 1.9, usage: { input: 1700, output: 61 }, hazards: { destructive: p(0.97), exfiltration: p(0.02), remote_code: p(0.01), weakens_security: p(0.04), outside_project: p(0.91) } } },
};
const decision: Decision = { effect: "deny", basis: { kind: "hazard", hazard: "destructive", p: p(0.97), risk: 1.9 } };
const meta = { at: "2026-09-23T10:00:00.000Z", posture: "observe" as const, backend: "mock" as const, wallMs: 431 as Ms };

test("attempt, denied and ran records round-trip through encode and decode as one line each", () => {
  const records = [
    attemptRecord(attempt, judged, decision, meta),
    attemptRecord(attempt, { kind: "routine", rule: "read.ls" }, { effect: "allow", basis: { kind: "rule", rule: "read.ls" } }, meta),
    attemptRecord(attempt, { ...judged, jev: { kind: "failed", error: { kind: "deadline", budgetMs: 3000 as Ms }, latencyMs: 3001 as Ms } }, { effect: "allow", basis: { kind: "jev_failed", error: { kind: "failed", error: { kind: "deadline", budgetMs: 3000 as Ms }, latencyMs: 3001 as Ms }, onError: "allow" } }, meta),
    labelRecord({ kind: "denied", ctx, reason: { kind: "rule", label: "Data Exfiltration" } }, meta.at),
    labelRecord({ kind: "denied", ctx, reason: { kind: "no_verdict" } }, meta.at),
    labelRecord({ kind: "ran", ctx, ok: false }, meta.at),
  ];
  const text = records.map(encode).join("");
  assert.equal(text.split("\n").length - 1, records.length);
  assert.deepEqual(decode(text), { records, malformed: 0 });
});

test("the excerpt and an `other` denial reason are redacted, and the excerpt is short", () => {
  const record = attemptRecord(attempt, judged, decision, meta);
  assert.ok(!leaks(encode(record), secret));
  assert.ok(record.excerpt.length < 260);
  const denied = labelRecord({ kind: "denied", ctx, reason: { kind: "other", text: fromHost(`blocked: request carried "Authorization: Bearer ${secret}" ${"z".repeat(500)}`) } }, meta.at);
  const line = encode(denied);
  assert.ok(!leaks(line, secret));
  assert.ok(line.length < 700);
});

test("the worst-case attempt line stays under the bound; encode refuses anything over it", () => {
  const long: Attempt = { ...attempt, ctx: { ...ctx, session: "s".repeat(64) as EventContext["session"], toolUseId: "t".repeat(64) as EventContext["toolUseId"], tool: "mcp__server__tool_name_that_is_long".repeat(2) as EventContext["tool"], agentId: "a".repeat(64) } };
  const line = encode(attemptRecord(long, judged, decision, meta));
  assert.ok(Buffer.byteLength(line) < LINE_BYTES_MAX, `${Buffer.byteLength(line)} bytes`);
  const huge = { ...labelRecord({ kind: "ran", ctx, ok: true }, meta.at), tool: "x".repeat(LINE_BYTES_MAX) as EventContext["tool"] };
  assert.throws(() => encode(huge), /over the 4000 byte bound/);
});

test("decode counts torn, foreign and wrong-version lines instead of throwing, and keeps the rest", () => {
  const good = encode(labelRecord({ kind: "ran", ctx, ok: true }, meta.at));
  const torn = good.slice(0, 40);
  const text = `${good}${torn}\n{"v":2,"kind":"ran"}\n\n{"hello":"world"}\nnot json at all\n${good}`;
  const { records, malformed } = decode(text);
  assert.equal(records.length, 2);
  assert.equal(malformed, 4);
  const event: HookEvent = { kind: "ran", ctx, ok: true };
  assert.deepEqual(records[0], labelRecord(event, meta.at));
});

test("logPath joins under the data dir", () => {
  assert.equal(logPath("/data/" as EventContext["cwd"]), "/data/log.jsonl");
  assert.equal(logPath("/data" as EventContext["cwd"]), "/data/log.jsonl");
});
