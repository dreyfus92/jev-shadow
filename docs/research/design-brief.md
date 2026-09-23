# Design brief: jev-shadow (working name)

A Claude Code plugin, built in public, that runs TypeSafe Jev as a shadow-first decision layer on tool calls, and can later enforce for hosts that have no built-in classifier. The research behind this is in `../jev-claude-research.md`. Read it before designing. Its "Recommendation" and "Gotchas" sections are constraints, not suggestions.

## Why this exists

The user runs Claude Code in `auto` permission mode on Max. Auto mode's classifier already gates the hazards a Jev gate would check. So the product is not "a gate". It is the instrument that measures whether Jev's typed verdicts agree with a real classifier on real coding actions, at zero latency, and only then turns into a gate for users who have no classifier (Manual mode, `dontAsk`, Codex, pi, Muse Code). No independent calibration data for Jev exists. This project produces it.

## Hard requirements for v0.1

1. **Modes** are an explicit state: `off`, `shadow`, `enforce`. Shadow uses async hooks (`"async": true`) and cannot affect the session by construction. Enforce uses a synchronous `PreToolUse` hook and emits allow (print nothing), `ask`, or `deny` with a reason.
2. **Local rule table first.** Read-only commands, the project's own test and build commands, and in-project edits are decided locally and never leave the machine. Rules are data, not an if-chain. jev-axi's fast path is the reference, including its known gaps (`&` not split, `sed -Ei`, `sort -o`, `find -fprintf`, `git diff --output`), which must be covered.
3. **Question pack.** jev-axi's five hazard nouls (`destructive`, `exfiltration`, `remote_code`, `weakens_security`, `outside_project`) plus a `risk` score. Model pinned to `jev-1.13.0`, never `jev-latest`. Nouls have no confidence field, so certainty for a noul is a documented derivation the design chooses.
4. **Backends.** TypeSafe direct, Vercel AI Gateway, OpenRouter, and a deterministic `mock` driven by a fixtures table so every test and every user without a key can run end to end. Each Jev call has one total deadline enforced with `AbortSignal`, below the hook's timeout. The official SDK has no total budget (10 s per attempt, 2 retries, Retry-After up to 60 s); the candidate decides whether to use it at all, and must say why.
5. **Redact before truncate.** The design must make truncating unredacted text impossible to express, for example by typing. Patterns must cover at least: PEM blocks, `sk-` and `sk_live_`, `AIza`, `glpat-`, `npm_`, `AKIA`/`ASIA`, `hf_`, `ghp_`/`github_pat_`, `-p<password>`, `--password x`, `Authorization: Bearer`, and `postgres://user:pass@`. A leak corpus fixture is part of the deliverable.
6. **Decision log.** JSONL in `${CLAUDE_PLUGIN_DATA}`. One record per hook event, keyed by `tool_use_id`, so a `PreToolUse` verdict, a `PermissionDenied` (the classifier's real denial, with its rule label), and a `PostToolUse` (the call ran) join into one labeled example. Never logs raw secrets or full tool input. Logs Jev's `usage` and measured latency.
7. **Report.** A command that reads the log and prints: per-hazard agreement between "hazard >= 0.8" and a classifier denial, over-refusal rate (Jev >= 0.45 where the classifier allowed), accuracy of the >= 0.8 band, latency p50/p95, and Jev token usage. The classifier is a reference, not ground truth; the report says so.
8. **Failure semantics.** Shadow fails open by construction. Enforce has an `onError` policy (`allow` | `ask` | `deny`) defaulting to `allow`, with docs stating that `ask` becomes a hard deny in `dontAsk` and `-p`, and that a CLI hook timeout always fails open.
9. **Config.** API key through plugin `userConfig` marked `sensitive` (arrives as an env var in the hook process). Mode, thresholds, backend, and a kill switch in a config file the user owns. Never enable by default in a repo; the README shows enabling per project via `.claude/settings.local.json`.
10. **Packaging.** TypeScript, ESM, Node 20 or newer, `hooks/hooks.json` plus a `bin/` entry that `node` runs directly after `tsc`. Zero runtime dependencies preferred. Tests with `node:test`. The core (parse event, decide locally, ask Jev, apply policy, log) is host-agnostic; Claude Code specifics live in a thin adapter so Codex, pi, and Muse Code (which share the same hook stdin contract) are v0.2 adapters, not rewrites.

## Non-goals for v0.1

UserPromptSubmit triage, Stop verify, PreCompact, per-turn model routing, PostToolUse output pruning (may appear as one extra shadow question later), a new MCP server, any agent other than Claude Code.

## Rubric (the picker's tool)

1. **Domain modeled in structure.** Hook events are a discriminated union parsed at the boundary. Mode is an explicit type, not booleans. Local rules are a table. Verdict, policy result, and log record are distinct typed values. No `any`, no optional fields that are always set.
2. **Interface depth.** One pure core, e.g. `decide(event, rules, verdict?) -> Decision`, with the shell (stdin, stdout, fs, network, clock) thin and injectable. Jev and hook wire JSON never appear on the public surface.
3. **Failure semantics encoded.** Total deadline, fail-open versus fail-closed per mode, and redact-before-truncate are enforced by types or structure, not by discipline.
4. **Testable without a key.** Mock backend, replay of real hook JSON fixtures, leak corpus, and a report over a fixture log all run under `node --test` with no network.
5. **Portability.** Nothing Claude-Code-specific below the adapter. Show the Codex adapter as a stub to prove it.
6. **Smallness.** v0.1 fits in about ten source files. No speculative abstraction. Every module hides something.

## Grounding artifacts

- `../jev-claude-research.md` (the recommendation, gotchas, and open questions)
- `explorer-claude-surfaces.md` (verified hook stdin and stdout fields for 2.1.280, plugin packaging rules, the four existing repos and their bugs)
- `explorer-jev-contract.md` (exact Jev request and response JSON, limits, SDK types and retry defaults)
- `explorer-attack-premise.md` (why shadow-first, what the classifier already does)
- `/tmp/jev-research/docs/hooks.md` (Claude Code hooks reference, local copy), `/tmp/jev-research/docs/plugins-reference.md`
- `/tmp/jev-research/jev-axi/src/safety.ts` and `src/recipes/questions.ts` (the question pack and fast path to improve on)
- `/tmp/jev-research/jev-use/src/redact.ts` (a redactor with known gaps)

## Deliverable per candidate

Write to your own output directory only:
- `DESIGN.md` shaped per the rationale template (Problem, Usage, Shape, Tradeoffs accepted, Alternatives considered, Open questions and risks, Next implementation step). Usage first. Show the README quickstart and three real call sites (the hook bin, a test, the report).
- `src/*.ts` type sketches: types, signatures, module map, `not implemented` bodies, `// TODO` pseudocode for the tricky parts (segment splitting, redaction ordering, join on tool_use_id, deadline).
- `hooks/hooks.json` and `.claude-plugin/plugin.json` as you would ship them.
