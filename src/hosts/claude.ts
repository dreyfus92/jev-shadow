/**
 * Claude Code adapter (verified against hooks.md for 2.1.280). The only file that knows Claude
 * Code's stdin and stdout JSON. Wire types are module-private.
 */
import type { AbsPath, Action, Decision, DenialReason, EventContext, HostAdapter, HostEnv, HookEvent, PermissionMode, SessionId, ToolName, ToolUseId } from "../core.js";
import { fromHost } from "../egress.js";
import { Secret } from "../jev.js";

/** Tool names this adapter models. Anything else parses to `unsupported`, so a matcher slip is harmless. */
const TOOLS = {
  Bash: "shell", PowerShell: "shell",
  Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  WebFetch: "fetch",
} as const;

// ------------------------------------------------------------------ wire (private)

interface WireCommon {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  agent_id?: string;
  mcp_server?: { name: string; source?: string };
}
interface WirePreToolUse extends WireCommon { hook_event_name: "PreToolUse" }
interface WirePermissionDenied extends WireCommon { hook_event_name: "PermissionDenied"; reason: string }
interface WirePostToolUse extends WireCommon { hook_event_name: "PostToolUse" }
interface WirePostToolUseFailure extends WireCommon { hook_event_name: "PostToolUseFailure"; error: string }
type Wire = WirePreToolUse | WirePermissionDenied | WirePostToolUse | WirePostToolUseFailure;

interface WireGateOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "ask" | "deny";
    permissionDecisionReason: string;
  };
}

// ------------------------------------------------------------------ adapter

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"];

const HAZARD_TEXT = {
  destructive: "irreversible deletion or overwrite of data",
  exfiltration: "sending secrets or private files off the machine",
  remote_code: "downloading and running unreviewed code",
  weakens_security: "weakening security controls",
  outside_project: "changing files or state outside the project",
} as const;

export const claude: HostAdapter = {
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
  parse(stdin: string, env: HostEnv): HookEvent | { kind: "unsupported"; why: string } {
    let value: unknown;
    try { value = JSON.parse(stdin); } catch { return { kind: "unsupported", why: "stdin is not JSON" }; }
    const wire = asWire(value);
    if (typeof wire === "string") return { kind: "unsupported", why: wire };
    const kind = toolKind(wire.tool_name);
    if (kind === null) return { kind: "unsupported", why: `tool ${wire.tool_name} is not modeled` };
    const cwd = absPath(wire.cwd);
    const ctx: EventContext = {
      host: "claude-code",
      session: wire.session_id as SessionId,
      toolUseId: wire.tool_use_id as ToolUseId,
      tool: wire.tool_name as ToolName,
      permissionMode: (PERMISSION_MODES as readonly string[]).includes(wire.permission_mode ?? "") ? (wire.permission_mode as PermissionMode) : "unknown",
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
  render(decision: Decision): string {
    if (decision.effect === "allow") return "";
    const tail = decision.effect === "deny"
      ? "Blocked. If this is really intended, explain it to the user and let them run it or approve it themselves."
      : "Needs explicit user approval before running.";
    const out: WireGateOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.effect,
        permissionDecisionReason: `${reasonHead(decision)} ${tail}`,
      },
    };
    return JSON.stringify(out);
  },

  /** userConfig `jev_api_key` (sensitive, Keychain) arrives as CLAUDE_PLUGIN_OPTION_JEV_API_KEY. */
  apiKey(env: HostEnv): Secret | null {
    return Secret.of(env["CLAUDE_PLUGIN_OPTION_JEV_API_KEY"] ?? "");
  },
};

function reasonHead(decision: Decision): string {
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

function asWire(value: unknown): Wire | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "stdin is not an object";
  const v = value as Record<string, unknown>;
  for (const field of ["session_id", "cwd", "hook_event_name", "tool_name", "tool_use_id"] as const) {
    if (typeof v[field] !== "string") return `missing ${field}`;
  }
  if (typeof v["tool_input"] !== "object" || v["tool_input"] === null) return "missing tool_input";
  if (v["permission_mode"] !== undefined && typeof v["permission_mode"] !== "string") return "permission_mode is not a string";
  if (v["agent_id"] !== undefined && typeof v["agent_id"] !== "string") return "agent_id is not a string";
  switch (v["hook_event_name"]) {
    case "PreToolUse":
    case "PostToolUse":
      return v as unknown as WirePreToolUse | WirePostToolUse;
    case "PermissionDenied":
      return typeof v["reason"] === "string" ? (v as unknown as WirePermissionDenied) : "missing reason";
    case "PostToolUseFailure":
      return typeof v["error"] === "string" ? (v as unknown as WirePostToolUseFailure) : "missing error";
    default:
      return `event ${String(v["hook_event_name"])} is not modeled`;
  }
}

function toolKind(name: string): (typeof TOOLS)[keyof typeof TOOLS] | "mcp" | null {
  if (name.startsWith("mcp__")) return "mcp";
  return Object.hasOwn(TOOLS, name) ? TOOLS[name as keyof typeof TOOLS] : null;
}

function toAction(kind: (typeof TOOLS)[keyof typeof TOOLS] | "mcp", wire: Wire): Action | string {
  const input = wire.tool_input;
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (kind) {
    case "shell":
      return { kind: "shell", dialect: wire.tool_name === "PowerShell" ? "powershell" : "posix", command: fromHost(str("command")) };
    case "write": {
      const path = str("file_path") || str("notebook_path");
      if (!path) return "write without a path";
      const edits = Array.isArray(input["edits"]) ? (input["edits"] as unknown[]) : [];
      const content = wire.tool_name === "MultiEdit"
        ? edits.map((e) => (typeof e === "object" && e !== null && typeof (e as Record<string, unknown>)["new_string"] === "string" ? String((e as Record<string, unknown>)["new_string"]) : "")).join("\n")
        : str("content") || str("new_string") || str("new_source");
      return { kind: "write", path: absPath(path), content: fromHost(content) };
    }
    case "fetch":
      return { kind: "fetch", url: fromHost(str("url")), prompt: fromHost(str("prompt")) };
    case "mcp":
      return { kind: "mcp", server: wire.mcp_server?.name ?? wire.tool_name.split("__")[1] ?? "", input: fromHost(JSON.stringify(input)) };
  }
}

function denialReason(reason: string): DenialReason {
  const trimmed = reason.trim();
  const rule = /^\[([^\]]+)\]/.exec(trimmed);
  if (rule?.[1]) return { kind: "rule", label: rule[1] };
  if (trimmed.startsWith("Auto mode could not evaluate")) return { kind: "no_verdict" };
  if (trimmed === "Classifier unavailable") return { kind: "unavailable" };
  return { kind: "other", text: fromHost(trimmed) };
}

/** Forward slashes, so Windows paths compare with the same rules (hooks.md, PreToolUse input). */
function absPath(path: string): AbsPath {
  return path.replace(/\\/g, "/") as AbsPath;
}
