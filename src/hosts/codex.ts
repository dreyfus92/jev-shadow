/**
 * Codex adapter, v0.2. A stub that exists to prove the seam: nothing below `HostAdapter` changes
 * to support it. Codex, pi and Muse Code share Claude's hook stdin contract closely enough that
 * each adapter is a parse and a render.
 */
import type { Decision, HostAdapter, HostEnv, HookEvent } from "../core.js";
import type { Secret } from "../jev.js";

export const codex: HostAdapter = {
  host: "codex",

  parse(_stdin: string, _env: HostEnv): HookEvent | { kind: "unsupported"; why: string } {
    // TODO v0.2: map Codex's shell tool (argv array, joined with shell quoting) to Action "shell".
    // Codex has no auto-mode classifier, so there is no PermissionDenied: every attempt label is
    // "ran" or "unlabeled", and actingPosture routes enforce to the gate.
    throw new Error("not implemented");
  },

  render(_decision: Decision): string {
    // TODO v0.2: Codex PreToolUse supports deny only (jev-axi hook.ts). `ask` renders as deny with
    // a reason that tells the agent to get the user's explicit approval first.
    throw new Error("not implemented");
  },

  apiKey(_env: HostEnv): Secret | null {
    // TODO v0.2: JEV_API_KEY from the environment Codex passes to hooks.
    throw new Error("not implemented");
  },
};
