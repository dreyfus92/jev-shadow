/**
 * Claude Code adapter (verified against hooks.md for 2.1.280). The only file that knows Claude
 * Code's stdin and stdout JSON. Wire types are module-private.
 */
import type { Decision, HostAdapter, HostEnv, HookEvent } from "../core.js";
import type { Secret } from "../jev.js";

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
    throw new Error("not implemented");
  },

  /**
   * allow -> "" (print nothing: the normal permission flow runs, and deny/ask rules still apply).
   * ask / deny -> WireGateOutput with a reason derived from `decision.basis`: hazard name,
   * probability, risk, and "jev-shadow" as the source. Never any tool input. The deny reason is
   * read by Claude; the ask reason by the user.
   * Never exit code 2: JSON carries every decision, so a crash (exit 1) can never block.
   */
  render(decision: Decision): string {
    throw new Error("not implemented");
  },

  /** userConfig `jev_api_key` (sensitive, Keychain) arrives as CLAUDE_PLUGIN_OPTION_JEV_API_KEY. */
  apiKey(env: HostEnv): Secret | null {
    throw new Error("not implemented");
  },
};

type _unused = Wire | WireGateOutput | typeof TOOLS;
