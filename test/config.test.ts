import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, GATE_BUDGET_MAX, OBSERVE_BUDGET_MAX, OFF, parseConfig, withMode } from "../src/config.js";

const enforce = JSON.stringify({ mode: "enforce" });

test("absent, invalid JSON, wrong schema, or a mode typo all mean off", () => {
  assert.deepEqual(parseConfig(undefined, {}), OFF);
  assert.deepEqual(parseConfig("{", {}), OFF);
  assert.deepEqual(parseConfig("[]", {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enfore" }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", backend: { kind: "custom", url: "http://evil" } }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", backend: { kind: "mock" } }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", policy: { thresholds: { deny: 1.2 } } }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", policy: { thresholds: { deny: 0.4, ask: 0.5 } } }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", policy: { onError: "block" } }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", budgets: { gate: "fast" } }), {}), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "enforce", budgets: { gate: 0 } }), {}), OFF);
});

test("a bare mode takes every default; partial thresholds merge; budgets clamp to the ceilings", () => {
  assert.deepEqual(parseConfig(enforce, {}), { ...DEFAULTS, mode: "enforce" });
  const c = parseConfig(JSON.stringify({ mode: "shadow", backend: { kind: "mock", fixtures: "/f.json" }, policy: { thresholds: { ask: 0.3 } }, budgets: { gate: 99_999, observe: 99_999 } }), {});
  assert.deepEqual(c, {
    mode: "shadow", backend: { kind: "mock", fixtures: "/f.json" },
    policy: { thresholds: { deny: 0.8, ask: 0.3, askRisk: 1.5 }, onError: "allow" },
    budgets: { gate: GATE_BUDGET_MAX, observe: OBSERVE_BUDGET_MAX },
  });
});

test("JEV_SHADOW_MODE may only lower the mode", () => {
  assert.equal(parseConfig(enforce, { JEV_SHADOW_MODE: "shadow" }).mode, "shadow");
  assert.deepEqual(parseConfig(enforce, { JEV_SHADOW_MODE: "off" }), OFF);
  assert.equal(parseConfig(JSON.stringify({ mode: "shadow" }), { JEV_SHADOW_MODE: "enforce" }).mode, "shadow");
  assert.deepEqual(parseConfig(undefined, { JEV_SHADOW_MODE: "enforce" }), OFF);
  assert.deepEqual(parseConfig(JSON.stringify({ mode: "off", backend: { kind: "vercel" } }), { JEV_SHADOW_MODE: "enforce" }), OFF);
  assert.equal(parseConfig(enforce, { JEV_SHADOW_MODE: "garbage" }).mode, "enforce");
});

test("withMode creates the file from the defaults, preserves other keys, and is idempotent", () => {
  const created = withMode(undefined, "shadow");
  assert.deepEqual(JSON.parse(created), { ...DEFAULTS, mode: "shadow" });
  assert.ok(created.endsWith("\n"));
  const custom = JSON.stringify({ mode: "shadow", backend: { kind: "vercel" }, note: "mine" });
  const off = withMode(custom, "off");
  assert.deepEqual(JSON.parse(off), { mode: "off", backend: { kind: "vercel" }, note: "mine" });
  assert.equal(withMode(off, "off"), off);
  assert.deepEqual(parseConfig(withMode(off, "enforce"), {}), { ...DEFAULTS, mode: "enforce", backend: { kind: "vercel" } });
  assert.deepEqual(JSON.parse(withMode("{ not json", "shadow")), { ...DEFAULTS, mode: "shadow" });
});
