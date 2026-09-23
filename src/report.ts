/**
 * Reads the log, joins the three per-event records into labeled examples, prints the numbers.
 * Pure except `render`'s caller writing to stdout. Running it twice gives the same output.
 *
 * The classifier is a reference, not ground truth. `render` prints that sentence first.
 */
import type { AttemptRecord, DeniedRecord, LogRecord } from "./log.js";
import type { Hazard } from "./jev.js";
import type { RuleId } from "./rules.js";
import type { Redacted } from "./egress.js";
import type { ToolUseId } from "./core.js";

/**
 * Fixed measurement bands, independent of the enforce thresholds in config. The report measures
 * Jev's probabilities against the classifier; tuning the policy must not move the yardstick.
 */
export const BANDS = { high: 0.8, flag: 0.45 } as const;

/** What the classifier did with the call. */
export type Label =
  | { readonly kind: "denied"; readonly denial: DeniedRecord["label"] }
  | { readonly kind: "ran" }            // passed permission (PostToolUse or PostToolUseFailure)
  | { readonly kind: "unlabeled" };     // neither arrived: user denial, session killed, non-auto mode

export interface Example {
  readonly attempt: AttemptRecord;
  readonly label: Label;
}

/**
 * Group by toolUseId in one pass (Map<ToolUseId, {attempt?, denied?, ran?}>), then emit one
 * Example per id that has an attempt.
 *   Duplicates of the same (toolUseId, kind), e.g. a hook re-fired on resume: keep the earliest `at`.
 *   Order of arrival does not matter; the PostToolUse record often lands before the async
 *   PreToolUse observer finishes its Jev call.
 *   denied and ran for one id cannot both be real; if both appear, denied wins and it is counted
 *   in `conflicts`.
 *   Label records with no attempt (tool outside the matcher, observer crashed) are counted, not joined.
 */
export function join(records: Iterable<LogRecord>): {
  readonly examples: readonly Example[];
  readonly orphanLabels: number;
  readonly conflicts: readonly ToolUseId[];
} {
  throw new Error("not implemented");
}

/**
 * Maps the classifier's rule labels to our hazards, so agreement can be checked per category.
 * Data, extended as new labels show up in `unmappedLabels`.
 */
export const LABEL_TO_HAZARD: Readonly<Record<string, Hazard>> = {
  "Data Exfiltration": "exfiltration",
  "Irreversible Local Destruction": "destructive",
  // TODO fill from auto-mode-config "Review denials"; unknown labels are reported, never guessed
};

/** A rate that always carries its counts, so a 3/4 is never printed as a bare 75%. */
export interface Ratio {
  readonly num: number;
  readonly den: number;
}

/** 2x2 of (Jev p >= high) against (classifier denied). Agreement and kappa derive at render. */
export interface Confusion {
  readonly bothYes: number;   // Jev high, classifier denied
  readonly jevOnly: number;   // Jev high, classifier let it run
  readonly clsOnly: number;   // classifier denied, Jev below high
  readonly bothNo: number;
}

export interface GroupReport {
  readonly backend: string;
  /** Response model; "unpinned" flag when the backend returns an unversioned id. */
  readonly model: string;
  readonly unpinned: boolean;
  readonly judged: number;
  /** Examples in permission_mode "auto" with a label: the only population compared to the classifier. */
  readonly comparable: number;
  readonly perHazard: Readonly<Record<Hazard, { readonly anyDenial: Confusion; readonly sameCategory: Confusion }>>;
  /** any hazard >= flag where the classifier let it run. */
  readonly overRefusal: Ratio;
  /** of calls with any hazard >= high, how many the classifier also denied. */
  readonly highBandAccuracy: Ratio;
  /** Jev call latency, cold process including TLS setup. Failures included; deadline hits at the budget. */
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly n: number };
  readonly tokens: { readonly input: number; readonly output: number; readonly calls: number };
  readonly errors: Readonly<Record<string, number>>;
}

export interface Report {
  readonly window: { readonly from: string; readonly to: string } | null;
  readonly attempts: number;
  readonly routine: number;
  /** One group per (backend, response model). Mock runs land in their own group, never mixed in. */
  readonly groups: readonly GroupReport[];
  /** Routine locally but the classifier denied: where the rule table is too loose. */
  readonly ruleMisses: readonly { readonly rule: RuleId; readonly label: string; readonly excerpt: Redacted }[];
  readonly unmappedLabels: readonly string[];
  readonly unlabeled: number;
  readonly orphanLabels: number;
  readonly malformedLines: number;
  /** Hook wall time p50/p95 by posture, so the gate's cost and the observer's are visible. */
  readonly wallMs: Readonly<Record<"observe" | "gate", { readonly p50: number; readonly p95: number; readonly n: number }>>;
}

export function summarize(
  joined: ReturnType<typeof join>,
  malformedLines: number,
): Report {
  throw new Error("not implemented");
}

/** Plain text, fixed-width tables, every rate as "num/den (pct)". First line is the ground-truth caveat. */
export function render(report: Report): string {
  throw new Error("not implemented");
}
