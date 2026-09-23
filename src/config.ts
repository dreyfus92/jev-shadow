/**
 * The user-owned config: `~/.config/jev-shadow/config.json` (or $JEV_SHADOW_CONFIG).
 *
 * Host-agnostic on purpose: Codex, pi and Muse Code adapters read the same file. Never read from
 * the project: a cloned repo must not be able to raise the mode, redirect the backend, or loosen
 * thresholds (the same reason Claude Code ignores project-level pluginConfigs).
 *
 * Read on every hook invocation (one small file), so `jev-shadow mode off` takes effect on the
 * next tool call in every running session without a restart.
 */
import type { AbsPath, Effect, Mode, Ms, Policy } from "./core.js";
import type { Probability } from "./jev.js";

export type BackendConfig =
  | { readonly kind: "typesafe" }
  | { readonly kind: "vercel" }
  | { readonly kind: "openrouter" }
  | { readonly kind: "mock"; readonly fixtures: AbsPath };

/**
 * A union on `mode` (grafted from arena candidate 3). `off` carries nothing, so a kill-switched
 * config cannot hold a backend or key to misuse, and `parseConfig` cannot invent one. Shadow and
 * enforce share `policy` on purpose: `decide` is the same pure function in both postures, and the
 * shadow log records what enforce would have done on a Jev failure (`policy.onError`). Candidate
 * 3 removed `onError` from shadow; that would have made the shadow log lie on failed calls.
 */
export type Config =
  | { readonly mode: "off" }
  | {
      readonly mode: "shadow" | "enforce";
      readonly backend: BackendConfig;
      readonly policy: Policy;
      /** Jev budget per posture, measured from process start. Clamped at parse. */
      readonly budgets: { readonly gate: Ms; readonly observe: Ms };
    };

export type ActiveConfig = Extract<Config, { mode: "shadow" | "enforce" }>;

/**
 * Must stay below hooks.json's gate `"timeout": 5` with margin for exit and write.
 * test/packaging.test.ts reads hooks.json and asserts GATE_HOOK_TIMEOUT_S * 1000 >= GATE_BUDGET_MAX + 1000,
 * so the two numbers cannot drift apart silently.
 */
export const GATE_HOOK_TIMEOUT_S = 5;
export const GATE_BUDGET_MAX = 3_500 as Ms;
/** Async hooks have no host timeout; this caps background pile-up. */
export const OBSERVE_BUDGET_MAX = 10_000 as Ms;

/**
 * No file means `off`. Installing and enabling the plugin sends nothing anywhere until the user
 * runs `jev-shadow mode shadow`, which writes this file.
 */
export const OFF: Config = { mode: "off" };

/** What `jev-shadow mode shadow` writes when no file exists. */
export const DEFAULTS: ActiveConfig = {
  mode: "shadow",
  backend: { kind: "typesafe" },
  policy: { thresholds: { deny: 0.8, ask: 0.45, askRisk: 1.5 } as Policy["thresholds"], onError: "allow" as Effect },
  budgets: { gate: 3_000 as Ms, observe: 8_000 as Ms },
};

/**
 * Pure. `text` is the file content or undefined when absent.
 *   absent, invalid JSON or schema   -> OFF (fail quiet, never fail open to enforce)
 *   thresholds outside [0,1], ask > deny -> invalid
 *   budgets                          -> clamped to *_BUDGET_MAX
 *   env JEV_SHADOW_MODE              -> may only lower the mode (enforce > shadow > off), never raise it,
 *                                       so an env var inherited from anywhere cannot turn egress on
 */
export function parseConfig(text: string | undefined, env: Readonly<Record<string, string | undefined>>): Config {
  const file = parseFile(text);
  if (file.mode === "off") return OFF;
  const lowered = env["JEV_SHADOW_MODE"];
  if (isMode(lowered) && RANK[lowered] < RANK[file.mode]) return lowered === "off" ? OFF : { ...file, mode: lowered };
  return file;
}

const RANK: Record<Mode, number> = { off: 0, shadow: 1, enforce: 2 };

function isMode(v: unknown): v is Mode {
  return v === "off" || v === "shadow" || v === "enforce";
}

function parseFile(text: string | undefined): Config {
  if (text === undefined) return OFF;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return OFF; }
  if (!isRecord(value) || !isMode(value["mode"]) || value["mode"] === "off") return OFF;
  const backend = parseBackend(value["backend"]);
  const policy = parsePolicy(value["policy"]);
  const budgets = parseBudgets(value["budgets"]);
  if (!backend || !policy || !budgets) return OFF;
  return { mode: value["mode"], backend, policy, budgets };
}

function parseBackend(v: unknown): BackendConfig | null {
  if (v === undefined) return DEFAULTS.backend;
  if (!isRecord(v)) return null;
  switch (v["kind"]) {
    case "typesafe": case "vercel": case "openrouter":
      return { kind: v["kind"] };
    case "mock":
      return typeof v["fixtures"] === "string" && v["fixtures"] !== "" ? { kind: "mock", fixtures: v["fixtures"] as AbsPath } : null;
    default:
      return null;
  }
}

function parsePolicy(v: unknown): Policy | null {
  if (v === undefined) return DEFAULTS.policy;
  if (!isRecord(v)) return null;
  const t = v["thresholds"] === undefined ? {} : v["thresholds"];
  if (!isRecord(t)) return null;
  const deny = t["deny"] ?? DEFAULTS.policy.thresholds.deny;
  const ask = t["ask"] ?? DEFAULTS.policy.thresholds.ask;
  const askRisk = t["askRisk"] ?? DEFAULTS.policy.thresholds.askRisk;
  if (!isUnit(deny) || !isUnit(ask) || ask > deny) return null;
  if (typeof askRisk !== "number" || !(askRisk >= 0 && askRisk <= 2)) return null;
  const onError = v["onError"] ?? DEFAULTS.policy.onError;
  if (onError !== "allow" && onError !== "ask" && onError !== "deny") return null;
  return { thresholds: { deny: deny as Probability, ask: ask as Probability, askRisk }, onError };
}

function parseBudgets(v: unknown): ActiveConfig["budgets"] | null {
  if (v === undefined) return DEFAULTS.budgets;
  if (!isRecord(v)) return null;
  const gate = v["gate"] ?? DEFAULTS.budgets.gate;
  const observe = v["observe"] ?? DEFAULTS.budgets.observe;
  if (!isPositive(gate) || !isPositive(observe)) return null;
  return { gate: Math.min(gate, GATE_BUDGET_MAX) as Ms, observe: Math.min(observe, OBSERVE_BUDGET_MAX) as Ms };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isUnit(v: unknown): v is number {
  return typeof v === "number" && v >= 0 && v <= 1;
}
function isPositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * For `jev-shadow mode <m>`. Returns the new file text; the shell writes it with
 * write-temp-then-rename, so running it twice is a no-op and a crash leaves the old file.
 * Creates the file from DEFAULTS when absent, preserving every other key when present.
 */
export function withMode(text: string | undefined, mode: Mode): string {
  let existing: unknown = undefined;
  if (text !== undefined) {
    try { existing = JSON.parse(text); } catch { existing = undefined; }
  }
  const base: Record<string, unknown> = isRecord(existing) ? existing : { ...DEFAULTS };
  return `${JSON.stringify({ ...base, mode }, null, 2)}\n`;
}
