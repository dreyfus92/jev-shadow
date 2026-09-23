import { fromHost } from "../egress.js";
import { Secret } from "../jev.js";
/** Tool names this adapter models. Anything else parses to `unsupported`, so a matcher slip is harmless. */
const TOOLS = {
    Bash: "shell", PowerShell: "shell",
    Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
    WebFetch: "fetch",
};
// ------------------------------------------------------------------ adapter
const PERMISSION_MODES = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"];
const HAZARD_TEXT = {
    destructive: "irreversible deletion or overwrite of data",
    exfiltration: "sending secrets or private files off the machine",
    remote_code: "downloading and running unreviewed code",
    weakens_security: "weakening security controls",
    outside_project: "changing files or state outside the project",
};
export const claude = {
    host: "claude-code",
    /**
     * JSON.parse, then validate by hand (zero deps):
     *   PreToolUse          -> attempt; tool_input mapped to Action:
     *                            Bash/PowerShell  command                       -> shell (posix | powershell)
     *                            Write            file_path, content            -> write
     *                            Edit             file_path, new_string         -> write
     *                            MultiEdit        file_path, edits[].new_string joined with "\n" -> write
     *                            NotebookEdit     notebook_path, new_source     -> write
     *                            WebFetch         url, prompt                   -> fetch
     *                            mcp__*           JSON.stringify(tool_input), mcp_server.name -> mcp
     *   PermissionDenied    -> denied; reason "[Label]" -> rule, "Auto mode could not evaluate..." -> no_verdict,
     *                          "Classifier unavailable" -> unavailable, else other
     *   PostToolUse         -> ran ok
     *   PostToolUseFailure  -> ran !ok
     *   anything else       -> unsupported
     * Every free-text field goes through fromHost() here and nowhere else.
     * projectRoot = env.CLAUDE_PROJECT_DIR ?? cwd. permission_mode absent -> "unknown".
     */
    parse(stdin, env) {
        let value;
        try {
            value = JSON.parse(stdin);
        }
        catch {
            return { kind: "unsupported", why: "stdin is not JSON" };
        }
        const wire = asWire(value);
        if (typeof wire === "string")
            return { kind: "unsupported", why: wire };
        const kind = toolKind(wire.tool_name);
        if (kind === null)
            return { kind: "unsupported", why: `tool ${wire.tool_name} is not modeled` };
        const cwd = absPath(wire.cwd);
        const ctx = {
            host: "claude-code",
            session: wire.session_id,
            toolUseId: wire.tool_use_id,
            tool: wire.tool_name,
            permissionMode: PERMISSION_MODES.includes(wire.permission_mode ?? "") ? wire.permission_mode : "unknown",
            cwd,
            projectRoot: env["CLAUDE_PROJECT_DIR"] ? absPath(env["CLAUDE_PROJECT_DIR"]) : cwd,
            agentId: wire.agent_id ?? null,
        };
        switch (wire.hook_event_name) {
            case "PreToolUse": {
                const action = toAction(kind, wire);
                return typeof action === "string" ? { kind: "unsupported", why: action } : { kind: "attempt", ctx, action };
            }
            case "PermissionDenied":
                return { kind: "denied", ctx, reason: denialReason(wire.reason) };
            case "PostToolUse":
                return { kind: "ran", ctx, ok: true };
            case "PostToolUseFailure":
                return { kind: "ran", ctx, ok: false };
        }
    },
    /**
     * allow -> "" (print nothing: the normal permission flow runs, and deny/ask rules still apply).
     * ask / deny -> WireGateOutput with a reason derived from `decision.basis`: hazard name,
     * probability, risk, and "jev-shadow" as the source. Never any tool input. The deny reason is
     * read by Claude; the ask reason by the user.
     * Never exit code 2: JSON carries every decision, so a crash (exit 1) can never block.
     */
    render(decision) {
        if (decision.effect === "allow")
            return "";
        const tail = decision.effect === "deny"
            ? "Blocked. If this is really intended, explain it to the user and let them run it or approve it themselves."
            : "Needs explicit user approval before running.";
        const out = {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision.effect,
                permissionDecisionReason: `${reasonHead(decision)} ${tail}`,
            },
        };
        return JSON.stringify(out);
    },
    /** userConfig `jev_api_key` (sensitive, Keychain) arrives as CLAUDE_PLUGIN_OPTION_JEV_API_KEY. */
    apiKey(env) {
        return Secret.of(env["CLAUDE_PLUGIN_OPTION_JEV_API_KEY"] ?? "");
    },
};
function reasonHead(decision) {
    const { basis } = decision;
    switch (basis.kind) {
        case "hazard":
            return `jev-shadow: likely ${HAZARD_TEXT[basis.hazard]} (p=${basis.p.toFixed(2)}, risk ${basis.risk.toFixed(1)} of 2).`;
        case "jev_failed":
            return `jev-shadow: the Jev check failed (${basis.error.error.kind}) and onError is ${basis.onError}.`;
        case "rule":
            return `jev-shadow: rule ${basis.rule}.`;
        case "below_thresholds":
            return "jev-shadow: below thresholds.";
    }
}
function asWire(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return "stdin is not an object";
    const v = value;
    for (const field of ["session_id", "cwd", "hook_event_name", "tool_name", "tool_use_id"]) {
        if (typeof v[field] !== "string")
            return `missing ${field}`;
    }
    if (typeof v["tool_input"] !== "object" || v["tool_input"] === null)
        return "missing tool_input";
    if (v["permission_mode"] !== undefined && typeof v["permission_mode"] !== "string")
        return "permission_mode is not a string";
    if (v["agent_id"] !== undefined && typeof v["agent_id"] !== "string")
        return "agent_id is not a string";
    switch (v["hook_event_name"]) {
        case "PreToolUse":
        case "PostToolUse":
            return v;
        case "PermissionDenied":
            return typeof v["reason"] === "string" ? v : "missing reason";
        case "PostToolUseFailure":
            return typeof v["error"] === "string" ? v : "missing error";
        default:
            return `event ${String(v["hook_event_name"])} is not modeled`;
    }
}
function toolKind(name) {
    if (name.startsWith("mcp__"))
        return "mcp";
    return Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
}
function toAction(kind, wire) {
    const input = wire.tool_input;
    const str = (key) => (typeof input[key] === "string" ? input[key] : "");
    switch (kind) {
        case "shell":
            return { kind: "shell", dialect: wire.tool_name === "PowerShell" ? "powershell" : "posix", command: fromHost(str("command")) };
        case "write": {
            const path = str("file_path") || str("notebook_path");
            if (!path)
                return "write without a path";
            const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
            const content = wire.tool_name === "MultiEdit"
                ? edits.map((e) => (typeof e === "object" && e !== null && typeof e["new_string"] === "string" ? String(e["new_string"]) : "")).join("\n")
                : str("content") || str("new_string") || str("new_source");
            return { kind: "write", path: absPath(path), content: fromHost(content) };
        }
        case "fetch":
            return { kind: "fetch", url: fromHost(str("url")), prompt: fromHost(str("prompt")) };
        case "mcp":
            return { kind: "mcp", server: wire.mcp_server?.name ?? wire.tool_name.split("__")[1] ?? "", input: fromHost(JSON.stringify(input)) };
    }
}
function denialReason(reason) {
    const trimmed = reason.trim();
    const rule = /^\[([^\]]+)\]/.exec(trimmed);
    if (rule?.[1])
        return { kind: "rule", label: rule[1] };
    if (trimmed.startsWith("Auto mode could not evaluate"))
        return { kind: "no_verdict" };
    if (trimmed === "Classifier unavailable")
        return { kind: "unavailable" };
    return { kind: "other", text: fromHost(trimmed) };
}
/** Forward slashes, so Windows paths compare with the same rules (hooks.md, PreToolUse input). */
function absPath(path) {
    return path.replace(/\\/g, "/");
}
