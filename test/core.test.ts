import { test } from "node:test";
import assert from "node:assert/strict";
import { actingPosture, assess, decide, type Assessment, type EventContext, type HookEvent, type Mode, type PermissionMode, type Policy, type Posture, type Ms } from "../src/core.js";
import { fromHost, type JevState } from "../src/egress.js";
import type { JevOutcome, Probability, Verdict } from "../src/jev.js";
import { leaks } from "./helpers.js";

const ctx = (permissionMode: PermissionMode): EventContext => ({
  host: "claude-code", session: "s" as EventContext["session"], toolUseId: "t" as EventContext["toolUseId"],
  tool: "Bash" as EventContext["tool"], permissionMode, cwd: "/p" as EventContext["cwd"], projectRoot: "/p" as EventContext["projectRoot"], agentId: null,
});
const shell = (command: string, permissionMode: PermissionMode = "default"): Extract<HookEvent, { kind: "attempt" }> =>
  ({ kind: "attempt", ctx: ctx(permissionMode), action: { kind: "shell", dialect: "posix", command: fromHost(command) } });

const MODES: readonly PermissionMode[] = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "unknown"];

const TABLE: readonly [mode: Mode, permissionMode: PermissionMode, expected: Posture | "none"][] = [
  ...MODES.map((pm): [Mode, PermissionMode, Posture | "none"] => ["off", pm, "none"]),
  ...MODES.map((pm): [Mode, PermissionMode, Posture | "none"] => ["shadow", pm, "observe"]),
  ["enforce", "default", "gate"],
  ["enforce", "plan", "gate"],
  ["enforce", "acceptEdits", "gate"],
  ["enforce", "auto", "observe"],
  ["enforce", "dontAsk", "gate"],
  ["enforce", "bypassPermissions", "gate"],
  ["enforce", "unknown", "gate"],
];

for (const [mode, pm, expected] of TABLE) {
  test(`actingPosture(${mode}, attempt in ${pm}) = ${expected}`, () => {
    assert.equal(actingPosture(mode, shell("x", pm)), expected);
  });
}

for (const mode of ["off", "shadow", "enforce"] as const) {
  for (const pm of MODES) {
    test(`actingPosture(${mode}, denied/ran in ${pm}) is never gate`, () => {
      const expected = mode === "off" ? "none" : "observe";
      assert.equal(actingPosture(mode, { kind: "denied", ctx: ctx(pm), reason: { kind: "no_verdict" } }), expected);
      assert.equal(actingPosture(mode, { kind: "ran", ctx: ctx(pm), ok: true }), expected);
    });
  }
}

const p = (n: number): Probability => n as Probability;
const policy: Policy = { thresholds: { deny: p(0.8), ask: p(0.45), askRisk: 1.5 }, onError: "allow" };
const verdict = (h: Partial<Record<keyof Verdict["hazards"], number>>, risk: number): JevOutcome => ({
  kind: "verdict", latencyMs: 1 as Ms,
  verdict: { model: "jev-1.13.0", usage: { input: 1, output: 1 }, risk, hazards: { destructive: p(0), exfiltration: p(0), remote_code: p(0), weakens_security: p(0), outside_project: p(0), ...(h as Partial<Record<keyof Verdict["hazards"], Probability>>) } },
});
const judged = (jev: JevOutcome): Assessment => ({ kind: "judged", miss: { kind: "unlisted", argv0: "x" }, jev, fingerprint: "f" });

test("decide keeps jev-axi's thresholds: blocking hazard >= deny denies; a non-blocking top denies only with high risk", () => {
  assert.deepEqual(decide(judged(verdict({ destructive: 0.97, outside_project: 0.99 }, 1.9)), policy), { effect: "deny", basis: { kind: "hazard", hazard: "destructive", p: 0.97, risk: 1.9 } });
  assert.deepEqual(decide(judged(verdict({ outside_project: 0.9 }, 1.9)), policy), { effect: "deny", basis: { kind: "hazard", hazard: "outside_project", p: 0.9, risk: 1.9 } });
  assert.deepEqual(decide(judged(verdict({ outside_project: 0.9 }, 1.0)), policy), { effect: "ask", basis: { kind: "hazard", hazard: "outside_project", p: 0.9, risk: 1.0 } });
  assert.deepEqual(decide(judged(verdict({ exfiltration: 0.5 }, 0.5)), policy), { effect: "ask", basis: { kind: "hazard", hazard: "exfiltration", p: 0.5, risk: 0.5 } });
  assert.equal(decide(judged(verdict({ remote_code: 0.1 }, 1.6)), policy).effect, "ask");
  assert.deepEqual(decide(judged(verdict({ destructive: 0.44 }, 1.49)), policy), { effect: "allow", basis: { kind: "below_thresholds" } });
  assert.equal(decide(judged(verdict({ destructive: 0.8 }, 0)), policy).effect, "deny");
  assert.equal(decide(judged(verdict({ destructive: 0.45 }, 0)), policy).effect, "ask");
});

test("decide: a failed call becomes onError with a jev_failed basis; routine is allow with its rule", () => {
  const failed: JevOutcome = { kind: "failed", error: { kind: "firewall" }, latencyMs: 9 as Ms };
  assert.deepEqual(decide(judged(failed), policy), { effect: "allow", basis: { kind: "jev_failed", error: failed, onError: "allow" } });
  assert.equal(decide(judged(failed), { ...policy, onError: "deny" }).effect, "deny");
  assert.deepEqual(decide({ kind: "routine", rule: "read.ls" }, policy), { effect: "allow", basis: { kind: "rule", rule: "read.ls" } });
});

test("assess: routine never calls ask; judged sends a redacted state with in-project scripts and fingerprints it", async () => {
  const asked: JevState[] = [];
  const secret = "ghp_EPJUo09jwQO10Y0ADsWJPiX1EwY2orTyRqBR";
  const deps = {
    ask: async (state: JevState): Promise<JevOutcome> => { asked.push(state); return verdict({}, 0); },
    readScripts: (refs: readonly string[]) => new Map(refs.map((r) => [r, fromHost(`echo ${secret}`)])),
  };
  assert.deepEqual(await assess(shell("ls -la"), deps), { kind: "routine", rule: "read.ls" });
  assert.equal(asked.length, 0);

  const out = await assess(shell(`GH=${secret} ./deploy.sh`), deps);
  assert.equal(out.kind, "judged");
  if (out.kind !== "judged") return;
  assert.deepEqual(out.miss, { kind: "unlisted", argv0: "GH=" });
  assert.match(out.fingerprint, /^[0-9a-f]{64}$/);
  const sent = JSON.stringify(asked);
  assert.ok(!leaks(sent, secret), sent);
  assert.ok("command" in (asked[0] ?? {}) && sent.includes("./deploy.sh"));
});
