import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Deadline, ENDPOINTS, Secret, ask, band, mockFetch, type Backend, type MockFixture, type Probability } from "../src/jev.js";
import type { JevState } from "../src/egress.js";
import type { Ms } from "../src/core.js";
import { fixture } from "./helpers.js";

const hazards = JSON.parse(fixture("jev/hazards.json")) as MockFixture[];
const state = (command: string): JevState => ({ tool: "Bash", cwd: "/p" as JevState["cwd"], command: command as JevState["cwd"] });
const now = (): number => performance.timeOrigin + performance.now();
const deadline = (budget = 2000): Deadline => Deadline.fromProcessStart(now(), budget as Ms);
const mock = (fixtures: readonly MockFixture[], seen?: string[]): Backend => ({ id: "mock", url: "mock:", model: "jev-1.13.0", key: null, fetch: mockFetch(fixtures, seen) });

test("verdict: the mock's raw wire JSON is parsed, the model and usage are recorded, latency is measured", async () => {
  const seen: string[] = [];
  const out = await ask(state("rm -rf ~"), mock(hazards, seen), deadline(), now);
  assert.equal(out.kind, "verdict");
  if (out.kind !== "verdict") return;
  assert.equal(out.verdict.hazards.destructive, 0.97);
  assert.equal(out.verdict.risk, 1.94);
  assert.equal(out.verdict.model, "jev-1.13.0");
  assert.deepEqual(out.verdict.usage, { input: 1712, output: 61 });
  assert.ok(out.latencyMs >= 0);
  const body = JSON.parse(seen[0] ?? "{}") as { model: string; state: unknown; questions: Record<string, { type: string }> };
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(body.state, state("rm -rf ~"));
  assert.deepEqual(Object.keys(body.questions), ["destructive", "exfiltration", "remote_code", "weakens_security", "outside_project", "risk"]);
});

test("the mock matches on the state, not on the question pack's own examples", async () => {
  const out = await ask(state("ls"), mock(hazards), deadline(), now);
  assert.ok(out.kind === "verdict" && out.verdict.hazards.destructive === 0.03);
});

test("403 is a firewall failure, other non-2xx is http with the status", async () => {
  const a = await ask(state("DROP TABLE users"), mock(hazards), deadline(), now);
  assert.deepEqual(a.kind === "failed" && a.error, { kind: "firewall" });
  const b = await ask(state("x"), mock([{ name: "429", match: "", status: 429, body: {} }]), deadline(), now);
  assert.deepEqual(b.kind === "failed" && b.error, { kind: "http", status: 429 });
});

test("deadline: a slow answer fails as deadline with the budget, and latency lands near the budget", async () => {
  const t0 = now();
  const out = await ask(state("slow"), mock([{ name: "slow", match: "", delayMs: 10_000, body: {} }]), deadline(30), now);
  assert.deepEqual(out.kind === "failed" && out.error, { kind: "deadline", budgetMs: 30 });
  assert.ok(now() - t0 < 1000, "did not wait for the fixture's delay");
});

test("a deadline already in the past aborts before any delay elapses", async () => {
  const out = await ask(state("x"), mock([{ name: "slow", match: "", delayMs: 10_000, body: {} }]), Deadline.fromProcessStart(now() - 5000, 100 as Ms), now);
  assert.equal(out.kind === "failed" && out.error.kind, "deadline");
});

test("malformed bodies name the field that failed", async () => {
  const ok = hazards[0]?.body as { model: string; answers: Record<string, unknown>; usage: unknown };
  const cases: [unknown, string][] = [
    [{}, "model"],
    [{ model: "jev-1.13.0" }, "answers"],
    [{ ...ok, answers: { ...ok.answers, remote_code: undefined } }, "answers.remote_code"],
    [{ ...ok, answers: { ...ok.answers, destructive: { type: "noul", noul: 1.2 } } }, "answers.destructive.noul"],
    [{ ...ok, answers: { ...ok.answers, risk: { type: "score", score: 3 } } }, "answers.risk.score"],
    [{ ...ok, usage: { input_tokens: -1, output_tokens: 1 } }, "usage.input_tokens"],
  ];
  for (const [body, at] of cases) {
    const out = await ask(state("x"), mock([{ name: "m", match: "", body }]), deadline(), now);
    assert.deepEqual(out.kind === "failed" && out.error, { kind: "malformed", at }, `for ${JSON.stringify(body).slice(0, 80)}`);
  }
});

test("no key on a paid backend fails as no_key without a request; a key is sent as a bearer header", async () => {
  const seen: string[] = [];
  const paid: Backend = { id: "typesafe", ...ENDPOINTS.typesafe, key: null, fetch: mockFetch(hazards, seen) };
  const out = await ask(state("x"), paid, deadline(), now);
  assert.deepEqual(out.kind === "failed" && out.error, { kind: "no_key" });
  assert.equal(seen.length, 0);

  let auth = "";
  const withKey: Backend = {
    ...paid, key: Secret.of("k-123"),
    fetch: async (_u, init) => { auth = String(new Headers(init?.headers).get("authorization")); return new Response(JSON.stringify(hazards[0]?.body), { status: 200 }); },
  };
  assert.equal((await ask(state("x"), withKey, deadline(), now)).kind, "verdict");
  assert.equal(auth, "Bearer k-123");
});

test("a fetch that throws is a network failure carrying the code, never an exception", async () => {
  const backend: Backend = { ...mock([]), fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }); } };
  const out = await ask(state("x"), backend, deadline(), now);
  assert.deepEqual(out.kind === "failed" && out.error, { kind: "network", code: "ECONNREFUSED" });
});

test("Secret never prints its value; empty is null", () => {
  const s = Secret.of("  abc  ");
  assert.ok(s);
  assert.equal(s.reveal(), "abc");
  assert.equal(JSON.stringify({ key: s }), '{"key":"[secret]"}');
  assert.equal(inspect(s), "[secret]");
  assert.equal(`${s}`, "[secret]");
  assert.equal(Secret.of("   "), null);
});

test("band is the two-sided 0.8 / 0.2 band", () => {
  assert.equal(band(0.8 as Probability), "yes");
  assert.equal(band(0.79 as Probability), "unsure");
  assert.equal(band(0.2 as Probability), "no");
  assert.equal(band(0.21 as Probability), "unsure");
});
