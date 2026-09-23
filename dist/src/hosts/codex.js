export const codex = {
    host: "codex",
    parse(_stdin, _env) {
        // TODO v0.2: map Codex's shell tool (argv array, joined with shell quoting) to Action "shell".
        // Codex has no auto-mode classifier, so there is no PermissionDenied: every attempt label is
        // "ran" or "unlabeled", and actingPosture routes enforce to the gate.
        throw new Error("not implemented");
    },
    render(_decision) {
        // TODO v0.2: Codex PreToolUse supports deny only (jev-axi hook.ts). `ask` renders as deny with
        // a reason that tells the agent to get the user's explicit approval first.
        throw new Error("not implemented");
    },
    apiKey(_env) {
        // TODO v0.2: JEV_API_KEY from the environment Codex passes to hooks.
        throw new Error("not implemented");
    },
};
