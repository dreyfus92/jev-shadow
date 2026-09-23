import { PACK_VERSION } from "./jev.js";
import { CLIP, clip, excerpt, redact } from "./egress.js";
import { HAZARDS } from "./jev.js";
/** The log path under a host-provided data dir. */
export function logPath(dataDir) {
    return `${dataDir.replace(/\/$/, "")}/log.jsonl`;
}
/** Serialize one record to one line, "\n"-terminated. Throws in tests if the line exceeds 4000 bytes. */
export const LINE_BYTES_MAX = 4000;
export function encode(record) {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > LINE_BYTES_MAX)
        throw new Error(`log line is ${bytes} bytes, over the ${LINE_BYTES_MAX} byte bound`);
    return line;
}
/**
 * Parse a whole log. Lines that fail validation are counted, not thrown: a torn or foreign line
 * must not hide the rest of the evidence. Unknown `v` counts as malformed.
 */
export function decode(text) {
    const records = [];
    let malformed = 0;
    for (const line of text.split("\n")) {
        if (line.trim() === "")
            continue;
        const record = parseLine(line);
        if (record)
            records.push(record);
        else
            malformed++;
    }
    return { records, malformed };
}
function parseLine(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || value["v"] !== 1)
        return null;
    const base = {
        at: value["at"], host: value["host"], session: value["session"], toolUseId: value["toolUseId"], tool: value["tool"], agentId: value["agentId"],
    };
    if (!isString(base.at) || !(base.host === "claude-code" || base.host === "codex") || !isString(base.session) || !isString(base.toolUseId) || !isString(base.tool))
        return null;
    if (!(base.agentId === null || isString(base.agentId)))
        return null;
    switch (value["kind"]) {
        case "attempt": {
            const jev = value["jev"];
            const basis = value["basis"];
            if (!isOneOf(value["permissionMode"], PERMISSION_MODES) || !isOneOf(value["posture"], ["observe", "gate"]) || !isOneOf(value["effect"], EFFECTS))
                return null;
            if (!isRecord(basis) || !isString(basis["kind"]) || !isJevField(jev) || !isString(value["excerpt"]) || !isNumber(value["wallMs"]))
                return null;
            return value;
        }
        case "denied": {
            const label = value["label"];
            if (!isRecord(label) || !isOneOf(label["kind"], ["rule", "no_verdict", "unavailable", "other"]))
                return null;
            if (label["kind"] === "rule" && !isString(label["label"]))
                return null;
            if (label["kind"] === "other" && !isString(label["text"]))
                return null;
            return value;
        }
        case "ran":
            return typeof value["ok"] === "boolean" ? value : null;
        default:
            return null;
    }
}
const PERMISSION_MODES = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "unknown"];
const EFFECTS = ["allow", "ask", "deny"];
function isJevField(v) {
    if (!isRecord(v))
        return false;
    if (v["kind"] === "not_asked")
        return isString(v["rule"]);
    if (v["kind"] !== "verdict" && v["kind"] !== "failed")
        return false;
    if (!isRecord(v["miss"]) || !isString(v["backend"]) || !isNumber(v["latencyMs"]) || !isString(v["fingerprint"]))
        return false;
    if (v["kind"] === "failed")
        return isRecord(v["error"]) && isString(v["error"]["kind"]);
    const hazards = v["hazards"];
    const usage = v["usage"];
    return isString(v["model"]) && isNumber(v["risk"]) && isRecord(hazards) && HAZARDS.every((h) => isNumber(hazards[h]))
        && isRecord(usage) && isNumber(usage["input"]) && isNumber(usage["output"]);
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v) {
    return typeof v === "string";
}
function isNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}
function isOneOf(v, options) {
    return isString(v) && options.includes(v);
}
/** The one constructor for attempt records. Excerpt comes from egress.ts, so it is redacted by type. */
export function attemptRecord(attempt, assessment, decision, meta) {
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
function jevField(assessment, backend) {
    if (assessment.kind === "routine")
        return { kind: "not_asked", rule: assessment.rule };
    const { miss, jev, fingerprint } = assessment;
    if (jev.kind === "failed")
        return { kind: "failed", miss, backend, error: jev.error, latencyMs: jev.latencyMs, fingerprint };
    const { verdict } = jev;
    return {
        kind: "verdict", miss, backend, pack: PACK_VERSION, model: verdict.model,
        hazards: verdict.hazards, risk: verdict.risk, usage: verdict.usage, latencyMs: jev.latencyMs, fingerprint,
    };
}
function base(event, at) {
    const { ctx } = event;
    return { v: 1, at, host: ctx.host, session: ctx.session, toolUseId: ctx.toolUseId, tool: ctx.tool, agentId: ctx.agentId };
}
/** Denied and ran records carry no Jev data and no input. */
export function labelRecord(event, at) {
    if (event.kind === "ran")
        return { ...base(event, at), kind: "ran", ok: event.ok };
    const { reason } = event;
    const label = reason.kind === "other" ? { kind: "other", text: clip(redact(reason.text), CLIP.excerpt) } : reason;
    return { ...base(event, at), kind: "denied", label };
}
