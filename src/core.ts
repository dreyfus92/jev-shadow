/**
 * The host-agnostic core. Owns the domain (events, actions, mode, decisions) and the two pure
 * functions everything else serves: `actingPosture` (who acts on this event) and `decide`
 * (what the effect would be). `assess` is the one async function; its effects are injected.
 *
 * Nothing in this file knows Claude Code, Jev wire JSON, or the filesystem.
 */
import type { Raw } from "./egress.js";
import type { JevOutcome, Hazard, Probability } from "./jev.js";
import type { JevState } from "./egress.js";
import { toJevState, scriptRefs } from "./egress.js";
import { triage, type RuleId, type Miss } from "./rules.js";

// ------------------------------------------------------------------ identifiers

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type ToolUseId = Brand<string, "ToolUseId">;
/** Absolute, normalized, forward-slash path. Only host adapters construct one. */
export type AbsPath = Brand<string, "AbsPath">;
export type Ms = Brand<number, "Ms">;

export type HostId = "claude-code" | "codex";
/** Verbatim tool name from the host, e.g. "Bash", "mcp__github__create_issue". */
export type ToolName = Brand<string, "ToolName">;

// ------------------------------------------------------------------ mode and posture

/** The user's switch. `off` is the kill switch; there is no separate boolean. */
export type Mode = "off" | "shadow" | "enforce";

/**
 * How this process was started, fixed by hooks.json argv, never by config.
 *   observe  started by an `"async": true` hook. Its IO type has no stdout (see cli.ts).
 *   gate     started by the synchronous PreToolUse hook. The only posture that can emit.
 */
export type Posture = "observe" | "gate";

/**
 * "default" is what Claude Code sends for Manual. "unknown" when the event omits the field
 * (not every event carries it). Never optional: absence is a value.
 */
export type PermissionMode =
  | "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "unknown";

/**
 * Which posture acts on this event, or none. Both hook processes for one event call this with
 * the same inputs, so exactly one posture acts by construction (a function has one return).
 *
 * Enforce yields to auto mode: where the host already runs a classifier, a Jev `ask` would only
 * force prompts auto mode skipped, so enforce observes instead of gating.
 *
 * The gate process may short-circuit before reading stdin when `mode !== "enforce"`, because
 * every branch that returns "gate" requires enforce. core.test.ts enumerates the table to pin it.
 */
export function actingPosture(mode: Mode, event: HookEvent): Posture | "none" {
  // TODO
  // off                                  -> none
  // event.kind !== "attempt"             -> observe   (denied / ran are labels, never gated)
  // shadow                               -> observe
  // enforce && permissionMode === "auto" -> observe
  // enforce                              -> gate
  throw new Error("not implemented");
}

// ------------------------------------------------------------------ events (parsed at the host boundary)

export interface EventContext {
  readonly host: HostId;
  readonly session: SessionId;
  readonly toolUseId: ToolUseId;
  readonly tool: ToolName;
  readonly permissionMode: PermissionMode;
  /** Where the tool runs. */
  readonly cwd: AbsPath;
  /** The project boundary for "in-project" rules. CLAUDE_PROJECT_DIR when set, else cwd. */
  readonly projectRoot: AbsPath;
  /** Present only inside a subagent, so null is a real state, not a missing field. */
  readonly agentId: string | null;
}

/**
 * The three things the harness learns about one tool call. Each arrives in its own process,
 * possibly concurrently, and becomes its own log record. The join happens in report.ts.
 */
export type HookEvent =
  | { readonly kind: "attempt"; readonly ctx: EventContext; readonly action: Action }
  | { readonly kind: "denied"; readonly ctx: EventContext; readonly reason: DenialReason }
  | { readonly kind: "ran"; readonly ctx: EventContext; readonly ok: boolean };

export type EventKind = HookEvent["kind"];

/** The classifier's denial, parsed from the host's reason text. */
export type DenialReason =
  | { readonly kind: "rule"; readonly label: string }       // "[Data Exfiltration]" -> "Data Exfiltration"
  | { readonly kind: "no_verdict" }                          // "Auto mode could not evaluate this action..."
  | { readonly kind: "unavailable" }                         // "Classifier unavailable"
  | { readonly kind: "other"; readonly text: Raw };          // redacted before logging

/**
 * What the tool call would do, as the rules and Jev see it. Free text stays `Raw` so the only
 * way to send or log it is through egress.ts.
 */
export type Action =
  | { readonly kind: "shell"; readonly dialect: "posix" | "powershell"; readonly command: Raw }
  | { readonly kind: "write"; readonly path: AbsPath; readonly content: Raw }
  | { readonly kind: "fetch"; readonly url: Raw; readonly prompt: Raw }
  | { readonly kind: "mcp"; readonly server: string; readonly input: Raw }
  | { readonly kind: "other"; readonly input: Raw };

export type Attempt = Extract<HookEvent, { kind: "attempt" }>;

// ------------------------------------------------------------------ host adapter contract

/**
 * Everything host-specific. v0.1 ships claude.ts; codex.ts is a stub proving the seam.
 * Wire types stay private to each adapter.
 */
export interface HostAdapter {
  readonly host: HostId;
  /** Validate stdin and parse into the domain. `unsupported` for events or tools we don't model. */
  parse(stdin: string, env: HostEnv): HookEvent | { readonly kind: "unsupported"; readonly why: string };
  /** Render a gate decision for stdout. `""` for allow, so the host's normal permission flow runs. */
  render(decision: Decision): string;
  /** The Jev key as this host delivers it (Claude: CLAUDE_PLUGIN_OPTION_JEV_API_KEY). */
  apiKey(env: HostEnv): import("./jev.js").Secret | null;
}

export type HostEnv = Readonly<Record<string, string | undefined>>;

// ------------------------------------------------------------------ assessment and decision

/** Local rules decided it, or Jev was asked (and answered or failed). Never both, never neither. */
export type Assessment =
  | { readonly kind: "routine"; readonly rule: RuleId }
  | {
      readonly kind: "judged";
      readonly miss: Miss;
      readonly jev: JevOutcome;
      /** sha256 of the redacted state, for variance and duplicate analysis. Never of raw text. */
      readonly fingerprint: string;
    };

export interface Thresholds {
  /** Any blocking hazard at or above this denies. Default 0.8. */
  readonly deny: Probability;
  /** Any hazard at or above this asks. Default 0.45. */
  readonly ask: Probability;
  /** Risk score (0..2) at or above this asks, and with a top hazard >= deny, denies. Default 1.5. */
  readonly askRisk: number;
}

export type Effect = "allow" | "ask" | "deny";

export interface Policy {
  readonly thresholds: Thresholds;
  /** Enforce only. What a failed Jev call becomes. Default "allow". */
  readonly onError: Effect;
}

/** Why the effect is what it is. Human reason text is derived from this at render time only. */
export type Basis =
  | { readonly kind: "rule"; readonly rule: RuleId }
  | { readonly kind: "hazard"; readonly hazard: Hazard; readonly p: Probability; readonly risk: number }
  | { readonly kind: "below_thresholds" }
  | { readonly kind: "jev_failed"; readonly error: JevOutcome & { kind: "failed" }; readonly onError: Effect };

export interface Decision {
  readonly effect: Effect;
  readonly basis: Basis;
}

/**
 * Hazards that deny on their own. `outside_project` only denies together with high risk.
 * Same semantics as jev-axi's `decide`, kept so the 44 labeled cases stay comparable.
 */
export const BLOCKING: ReadonlySet<Hazard> = new Set<Hazard>([
  "destructive", "exfiltration", "remote_code", "weakens_security",
]);

/**
 * Pure. Computed identically in shadow and enforce; the posture decides whether it is rendered.
 * That is the point of shadow: the logged `effect` is exactly what enforce would have done.
 */
export function decide(assessment: Assessment, policy: Policy): Decision {
  // TODO
  // routine                          -> allow, basis rule
  // judged, jev failed               -> policy.onError, basis jev_failed
  // judged, verdict:
  //   ranked = hazards sorted by p desc
  //   first BLOCKING hazard with p >= deny           -> deny
  //   top p >= deny && risk >= askRisk               -> deny (top)
  //   top p >= ask || risk >= askRisk                -> ask  (top)
  //   else                                           -> allow, below_thresholds
  throw new Error("not implemented");
}

/** The effects `assess` needs. The deadline is already bound into `ask` by the shell. */
export interface AssessDeps {
  readonly ask: (state: JevState) => Promise<JevOutcome>;
  /** Read the local scripts a shell command runs, inside the project only. Missing -> absent. */
  readonly readScripts: (refs: readonly string[], ctx: EventContext) => ReadonlyMap<string, Raw>;
}

/**
 * Rules first; Jev only for what the rules don't clear. `ask` never throws (jev.ts turns every
 * failure into a `failed` outcome), so neither does this.
 */
export async function assess(attempt: Attempt, deps: AssessDeps): Promise<Assessment> {
  // TODO
  // const t = triage(attempt.action, attempt.ctx)
  // if (t.kind === "routine") return t
  // const scripts = deps.readScripts(scriptRefs(attempt.action), attempt.ctx)
  // const state = toJevState(attempt.action, attempt.ctx, scripts)   // redact-then-clip inside
  // return { kind: "judged", miss: t.miss, jev: await deps.ask(state), fingerprint: fingerprint(state) }
  void triage; void toJevState; void scriptRefs;
  throw new Error("not implemented");
}
