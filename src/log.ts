/**
 * The decision log: `${CLAUDE_PLUGIN_DATA}/log.jsonl`, append-only, one record per hook event.
 *
 * Per-actor writes, merge at read. The PreToolUse observer (possibly still waiting on Jev), the
 * PermissionDenied observer and the PostToolUse observer for one tool call are three processes
 * that can run at the same time. None of them reads or rewrites another's record; each appends
 * its own line, and report.ts joins on toolUseId. No lock, no read-modify-write.
 *
 * Each record is written with one `appendFileSync(path, line)` on an O_APPEND descriptor, and
 * every line is bounded far below PIPE_BUF (4096 bytes) by construction: the only free text is
 * the 200-char redacted excerpt and short enums. Concurrent appends therefore land whole.
 *
 * Never logged: raw tool input, file contents, the API key, Jev's request body.
 */
import type {
  Basis, Effect, HostId, PermissionMode, Posture, SessionId, ToolName, ToolUseId, AbsPath, Ms,
} from "./core.js";
import type { Redacted } from "./egress.js";
import type { BackendId, Hazard, JevError, PACK_VERSION } from "./jev.js";
import type { Miss, RuleId } from "./rules.js";

interface RecordBase {
  readonly v: 1;
  /** ISO-8601 with ms. */
  readonly at: string;
  readonly host: HostId;
  readonly session: SessionId;
  readonly toolUseId: ToolUseId;
  readonly tool: ToolName;
  readonly agentId: string | null;
}

/** What Jev contributed to an attempt, flattened for JSON. */
export type JevField =
  | { readonly kind: "not_asked"; readonly rule: RuleId }
  | {
      readonly kind: "verdict";
      readonly miss: Miss;
      readonly backend: BackendId;
      readonly pack: typeof PACK_VERSION;
      readonly model: string;
      readonly hazards: Readonly<Record<Hazard, number>>;
      readonly risk: number;
      readonly usage: { readonly input: number; readonly output: number };
      readonly latencyMs: Ms;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "failed";
      readonly miss: Miss;
      readonly backend: BackendId;
      readonly error: JevError;
      readonly latencyMs: Ms;
      readonly fingerprint: string;
    };

export interface AttemptRecord extends RecordBase {
  readonly kind: "attempt";
  readonly permissionMode: PermissionMode;
  /** Which posture acted. `gate` means the effect was applied; `observe` means it was only logged. */
  readonly posture: Posture;
  /** What enforce does (gate) or would have done (observe). Same computation either way. */
  readonly effect: Effect;
  readonly basis: Basis;
  readonly jev: JevField;
  readonly excerpt: Redacted;
  /** Process start to record write, the hook's full cost. */
  readonly wallMs: Ms;
}

export interface DeniedRecord extends RecordBase {
  readonly kind: "denied";
  readonly label:
    | { readonly kind: "rule"; readonly label: string }
    | { readonly kind: "no_verdict" }
    | { readonly kind: "unavailable" }
    | { readonly kind: "other"; readonly text: Redacted };
}

export interface RanRecord extends RecordBase {
  readonly kind: "ran";
  /** false for PostToolUseFailure: the call passed permission and then errored. */
  readonly ok: boolean;
}

export type LogRecord = AttemptRecord | DeniedRecord | RanRecord;

/** The log path under a host-provided data dir. */
export function logPath(dataDir: AbsPath): AbsPath {
  throw new Error("not implemented");
}

/** Serialize one record to one line, "\n"-terminated. Throws in tests if the line exceeds 4000 bytes. */
export function encode(record: LogRecord): string {
  throw new Error("not implemented");
}

/**
 * Parse a whole log. Lines that fail validation are counted, not thrown: a torn or foreign line
 * must not hide the rest of the evidence. Unknown `v` counts as malformed.
 */
export function decode(text: string): { readonly records: readonly LogRecord[]; readonly malformed: number } {
  throw new Error("not implemented");
}

/** The one constructor for attempt records. Excerpt comes from egress.ts, so it is redacted by type. */
export function attemptRecord(
  attempt: import("./core.js").Attempt,
  assessment: import("./core.js").Assessment,
  decision: import("./core.js").Decision,
  meta: { readonly at: string; readonly posture: Posture; readonly backend: BackendId; readonly wallMs: Ms },
): AttemptRecord {
  throw new Error("not implemented");
}

/** Denied and ran records carry no Jev data and no input. */
export function labelRecord(
  event: Exclude<import("./core.js").HookEvent, { kind: "attempt" }>,
  at: string,
): DeniedRecord | RanRecord {
  // TODO denied "other" reason text goes through redact() before it is stored
  throw new Error("not implemented");
}
