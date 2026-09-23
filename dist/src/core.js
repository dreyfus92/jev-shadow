import { toJevState, scriptRefs, fingerprint } from "./egress.js";
import { triage } from "./rules.js";
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
export function actingPosture(mode, event) {
    if (mode === "off")
        return "none";
    if (event.kind !== "attempt" || mode === "shadow")
        return "observe";
    return event.ctx.permissionMode === "auto" ? "observe" : "gate";
}
/**
 * Hazards that deny on their own. `outside_project` only denies together with high risk.
 * Same semantics as jev-axi's `decide`, kept so the 44 labeled cases stay comparable.
 */
export const BLOCKING = new Set([
    "destructive", "exfiltration", "remote_code", "weakens_security",
]);
/**
 * Pure. Computed identically in shadow and enforce; the posture decides whether it is rendered.
 * That is the point of shadow: the logged `effect` is exactly what enforce would have done.
 */
export function decide(assessment, policy) {
    if (assessment.kind === "routine")
        return { effect: "allow", basis: { kind: "rule", rule: assessment.rule } };
    const { jev } = assessment;
    if (jev.kind === "failed")
        return { effect: policy.onError, basis: { kind: "jev_failed", error: jev, onError: policy.onError } };
    const { hazards, risk } = jev.verdict;
    const { deny, ask, askRisk } = policy.thresholds;
    const ranked = Object.entries(hazards).sort((a, b) => b[1] - a[1]);
    const top = ranked[0] ?? ["destructive", 0];
    const blocking = ranked.find(([h, p]) => BLOCKING.has(h) && p >= deny);
    const basisOf = ([hazard, p]) => ({ kind: "hazard", hazard, p, risk });
    if (blocking)
        return { effect: "deny", basis: basisOf(blocking) };
    if (top[1] >= deny && risk >= askRisk)
        return { effect: "deny", basis: basisOf(top) };
    if (top[1] >= ask || risk >= askRisk)
        return { effect: "ask", basis: basisOf(top) };
    return { effect: "allow", basis: { kind: "below_thresholds" } };
}
/**
 * Rules first; Jev only for what the rules don't clear. `ask` never throws (jev.ts turns every
 * failure into a `failed` outcome), so neither does this.
 */
export async function assess(attempt, deps) {
    const t = triage(attempt.action, attempt.ctx);
    if (t.kind === "routine")
        return t;
    const scripts = deps.readScripts(scriptRefs(attempt.action), attempt.ctx);
    const state = toJevState(attempt.action, attempt.ctx, scripts);
    return { kind: "judged", miss: t.miss, jev: await deps.ask(state), fingerprint: fingerprint(state) };
}
