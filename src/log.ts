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
import type { BackendId, Hazard, JevError } from "./jev.js";
import { PACK_VERSION } from "./jev.js";
import type { Miss, RuleId } from "./rules.js";
import type { Attempt, Assessment, Decision, HookEvent } from "./core.js";
import { CLIP, clip, excerpt, redact } from "./egress.js";
import { HAZARDS } from "./jev.js";

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
  return `${dataDir.replace(/\/$/, "")}/log.jsonl` as AbsPath;
}

/** Serialize one record to one line, "\n"-terminated. Throws in tests if the line exceeds 4000 bytes. */
export const LINE_BYTES_MAX = 4000;

export function encode(record: LogRecord): string {
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > LINE_BYTES_MAX) throw new Error(`log line is ${bytes} bytes, over the ${LINE_BYTES_MAX} byte bound`);
  return line;
}

/**
 * Parse a whole log. Lines that fail validation are counted, not thrown: a torn or foreign line
 * must not hide the rest of the evidence. Unknown `v` counts as malformed.
 */
export function decode(text: string): { readonly records: readonly LogRecord[]; readonly malformed: number } {
  const records: LogRecord[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseLine(line);
    if (record) records.push(record); else malformed++;
  }
  return { records, malformed };
}

function parseLine(line: string): LogRecord | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value) || value["v"] !== 1) return null;
  const base = {
    at: value["at"], host: value["host"], session: value["session"], toolUseId: value["toolUseId"], tool: value["tool"], agentId: value["agentId"],
  };
  if (!isString(base.at) || !(base.host === "claude-code" || base.host === "codex") || !isString(base.session) || !isString(base.toolUseId) || !isString(base.tool)) return null;
  if (!(base.agentId === null || isString(base.agentId))) return null;
  switch (value["kind"]) {
    case "attempt": {
      const jev = value["jev"];
      const basis = value["basis"];
      if (!isOneOf(value["permissionMode"], PERMISSION_MODES) || !isOneOf(value["posture"], ["observe", "gate"]) || !isOneOf(value["effect"], EFFECTS)) return null;
      if (!isRecord(basis) || !isString(basis["kind"]) || !isJevField(jev) || !isString(value["excerpt"]) || !isNumber(value["wallMs"])) return null;
      return value as unknown as AttemptRecord;
    }
    case "denied": {
      const label = value["label"];
      if (!isRecord(label) || !isOneOf(label["kind"], ["rule", "no_verdict", "unavailable", "other"])) return null;
      if (label["kind"] === "rule" && !isString(label["label"])) return null;
      if (label["kind"] === "other" && !isString(label["text"])) return null;
      return value as unknown as DeniedRecord;
    }
    case "ran":
      return typeof value["ok"] === "boolean" ? (value as unknown as RanRecord) : null;
    default:
      return null;
  }
}

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "unknown"];
const EFFECTS: readonly Effect[] = ["allow", "ask", "deny"];

function isJevField(v: unknown): v is JevField {
  if (!isRecord(v)) return false;
  if (v["kind"] === "not_asked") return isString(v["rule"]);
  if (v["kind"] !== "verdict" && v["kind"] !== "failed") return false;
  if (!isRecord(v["miss"]) || !isString(v["backend"]) || !isNumber(v["latencyMs"]) || !isString(v["fingerprint"])) return false;
  if (v["kind"] === "failed") return isRecord(v["error"]) && isString(v["error"]["kind"]);
  const hazards = v["hazards"];
  const usage = v["usage"];
  return isString(v["model"]) && isNumber(v["risk"]) && isRecord(hazards) && HAZARDS.every((h) => isNumber(hazards[h]))
    && isRecord(usage) && isNumber(usage["input"]) && isNumber(usage["output"]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isOneOf<T extends string>(v: unknown, options: readonly T[]): v is T {
  return isString(v) && (options as readonly string[]).includes(v);
}

/** The one constructor for attempt records. Excerpt comes from egress.ts, so it is redacted by type. */
export function attemptRecord(
  attempt: Attempt,
  assessment: Assessment,
  decision: Decision,
  meta: { readonly at: string; readonly posture: Posture; readonly backend: BackendId; readonly wallMs: Ms },
): AttemptRecord {
  return {
    ...base(attempt, meta.at),
    kind: "attempt",
    permissionMode: attempt.ctx.permissionMode,
    posture: meta.posture,
    effect: decision.effect,
    basis: decision.basis,
    jev: jevField(assessment, meta.backend),
    excerpt: excerpt(attempt.action),
    wallMs: meta.wallMs,
  };
}

function jevField(assessment: Assessment, backend: BackendId): JevField {
  if (assessment.kind === "routine") return { kind: "not_asked", rule: assessment.rule };
  const { miss, jev, fingerprint } = assessment;
  if (jev.kind === "failed") return { kind: "failed", miss, backend, error: jev.error, latencyMs: jev.latencyMs, fingerprint };
  const { verdict } = jev;
  return {
    kind: "verdict", miss, backend, pack: PACK_VERSION, model: verdict.model,
    hazards: verdict.hazards, risk: verdict.risk, usage: verdict.usage, latencyMs: jev.latencyMs, fingerprint,
  };
}

function base(event: HookEvent, at: string): RecordBase {
  const { ctx } = event;
  return { v: 1, at, host: ctx.host, session: ctx.session, toolUseId: ctx.toolUseId, tool: ctx.tool, agentId: ctx.agentId };
}

/** Denied and ran records carry no Jev data and no input. */
export function labelRecord(event: Exclude<HookEvent, { kind: "attempt" }>, at: string): DeniedRecord | RanRecord {
  if (event.kind === "ran") return { ...base(event, at), kind: "ran", ok: event.ok };
  const { reason } = event;
  const label: DeniedRecord["label"] = reason.kind === "other" ? { kind: "other", text: clip(redact(reason.text), CLIP.excerpt) } : reason;
  return { ...base(event, at), kind: "denied", label };
}
