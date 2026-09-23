# Explorer 2: the Muse + Jev playbook, read as code

### Components found

**muse-jev-playbook** (`/tmp/jev-research/muse-jev-playbook`, one commit `70edf68`, created 2026-09-22, forked in spirit from `Bodila51/grok-bot-jev` created 2026-09-19)
- `src/router.py`: the whole engine. `_bypassed` (L12-17), `INTENT_CRITERIA` (L20-28), `build_questions` (L31-57), `normalize_state` (L60-70), `decide_action` (L73-126), `route_task` (L129-175).
- `src/jev_client.py:10` `system_one()`: calls `ensure_typesafe_api_key()`, then `TypeSafeClient(model=...).system_one(state=, questions=)`.
- `src/secrets.py:6` `ensure_typesafe_api_key()`: reads `os.environ["TYPESAFE_API_KEY"]` and nothing else. If the key is missing it raises `SystemExit`, which kills the process.
- `src/config.py:13` `load_config()`: reads `config.yaml`, falling back to `config.example.yaml`. Defaults are `enabled: true`, `mode: shadow`, `model: jev-latest`.
- `src/logger.py:9` `log_run()`: appends one JSONL line to `logs/runs.jsonl`.
- `src/cli.py`: `python -m src.cli '<json state>'`.
- `scripts/test_policy.py`: tests `decide_action` offline with `SimpleNamespace` stubs (9 cases).
- `scripts/dry_run.py`: sends 5 states through `route_task`. It only makes no network calls when `enabled: false`.
- `recipes/*.json`: six single-line JSON files with the keys `_description`, `_policy`, `_questions`, `_state_template`. No code loads them.
- `skill/jev-decision-layer.SKILL.md`, `docs/{architecture,concepts,policy,prompting,measurement}.md`, `examples/{ab-template.json,cli-usage.md,flights-sep-2026.md}`.
- The SDK it depends on is `typesafe-sdk` 0.7.1 on PyPI. Installed into `/tmp/jev-research/venv` and read:
  - Endpoint: `POST https://api.typesafe.ai/v1/systemone` with body `{state, model, questions}`. Default timeout 10s. Env vars: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`.
  - Answer shapes: `ChoiceAnswer{choice, confidence, probabilities}`, `ScoreAnswer{score (expected value), confidence, legend, probabilities}`, `NoulAnswer{noul}`. A noul answer carries only P(yes) and has **no confidence field**.
  - The response also carries `usage{input_tokens, output_tokens}`, and the SDK says output tokens are free.

**opencode-jev-orchestrator** (`/tmp/jev-research/opencode-jev-orchestrator`, v0.2.1, all commits dated 2026-09-18; 76/76 tests pass locally)
- `src/index.ts`: the OpenCode `Plugin` entry. Any config error returns `{}`, so the plugin fails open.
- `src/adapter.ts` `createHooks()` (L111): registers the `config`, `tool` (`jev_escalate`, `jev_parallel`), `event`, `command.execute.before` and `chat.message` hooks.
- `src/jev.ts` `askJev()` (L117): calls Jev with a 1500ms timeout, a 3000ms deadline enforced by `AbortController`, and 1 retry. Every failure returns `null`. `resolveApiKey()` (L16) checks the env vars `JEV_API_KEY`, `JEV_KEY`, `TYPESAFE_API_KEY`, then `~/.config/opencode/opencode-jev-orchestrator.key`, then `~/.config/opencode/.env`.
- `src/config.ts` `QUESTIONS` (L56-116): three 10-level `score` questions (`task_complexity`, `reasoning_required`, `tool_complexity`) plus the `model_tier` choice across `fast`/`balanced`/`strong`/`long`. Each tier definition has `what`, `signals` and `not_for` fields, so the criteria are objects rather than strings.
- `src/policy.ts` `decideAction()` (L199) is the live policy. `decide()` (L113) is legacy and only used for the "use luna" override. `actionHint()` (L288) writes the text injected into the prompt.
- `src/delegate.ts` `spawnOrResumeChild()` (L190): creates a child session, forwards the parent transcript near-full (or only the delta on resume), polls until the child is idle, and returns its last assistant text.
- `src/sessions.ts`: per-session state covering strong streak, internal child IDs, and escalate-hint-missed tracking. `src/quota.ts` and `src/schedule.ts` handle OpenCode Go quota and DeepSeek peak hours.

### Flow (route_task step by step, with the rule precedence in decide_action)

1. `load_config()` and `resolve_log_path()` run and create `logs/`.
2. **Kill switch** (L134): if `enabled` is false, or `_bypassed(state)` finds `"bypass jev"` or `"no jev"` (case-insensitive substring) in `goal`, `raw`, `user_message` or `notes`, it returns `{action: proceed_full, jev_used: false}`. It **still logs** `state_goal[:300]`.
3. `normalize_state()` reduces the input to 8 fields: `goal` (from `goal` or `raw`), `kind_hint` (from `kind` or `kind_hint`), `has_cached_artifact = bool(state["cached_artifact"])`, `cached_note`, `prior_error`, `same_error_count`, `sources_found`, `constraints`. Everything else is dropped. A mock run: a `user_message` containing `sk-abc123` was not sent to Jev. The only redaction is this field dropping.
4. `build_questions()` always sends the same 5-question pack, whatever recipe you picked: `intent` (choice over 7 labels: chat, lookup, research, browser, coding, write, account), `reuse_cache` (noul), `needs_subagent` (noul), `stop_retry` (noul), `complexity` (score over 3 levels).
5. `system_one()` makes one synchronous SDK call. There is **no try/except**. A mock that raised `TimeoutError` made `route_task` raise, and a missing key makes it exit through `SystemExit`.
6. `decide_action()` is an `if/elif` chain, so the **first match wins**, in this order:
   1. `has_cached_artifact` AND `reuse >= reuse_min` (0.65) -> `reuse_cache`
   2. `same_error_count >= max_retries_same_error` (1) AND `stop >= stop_retry_min` (0.55) -> `stop_retry`
   3. `intent == lookup` AND `confidence >= min_choice_confidence` (0.55) -> `run_deterministic`
   4. `intent == chat` AND `confidence >= 0.55` -> `chat_only`
   5. `intent == account` at **any** confidence -> `ask_human`
   6. `needs_subagent >= subagent_min` (0.75) -> `allow_subagent`
   7. `intent in {research, browser}` at **any** confidence -> `research_capped`
   8. otherwise -> `proceed_full`. This is where `coding` and `write` land unless rule 6 fires.

   The `complexity` score is computed (L87, divided by 2) and logged, but **no rule uses it**.
7. The output has the shape `{action, reason, mode, jev_used, details, policy:{honor_in_active_mode: True, shadow_mode_is_advisory}}`. Shadow and active mode produce identical code paths; the mode is only echoed back. Nothing in the code enforces anything.
8. `log_run` writes `{ts, event, goal[:300], action, reason, mode, details}`. The live log line has **no** `jev_used`, latency, `questions`, `agent_did` or `outcome`, even though docs/measurement.md says a log line should contain them.

Precedence results verified with a mock (`/tmp/jev-research/mock_e2e.py`):

| Input | Action | Why it matters |
|---|---|---|
| account intent + fresh cache, reuse=0.9 | `reuse_cache` | beats `ask_human` |
| account intent + same_error_count=1, stop=0.9 | `stop_retry` | beats `ask_human` |
| lookup intent + sub=0.9 | `run_deterministic` | |
| chat intent at 0.5 confidence | `proceed_full` | |
| coding intent, heavy complexity | `proceed_full` | |
| same_error_count=1 | `stop_retry` | fires on the first repeat, although the skill says "2+ times" |

### Files read

- Playbook, all files: `src/*.py`, `config.example.yaml`, `requirements.txt`, `recipes/*.json`, `examples/*`, `skill/jev-decision-layer.SKILL.md`, `docs/*.md`, `scripts/*.py`, `README.md`, `QUICKSTART.md`, `TROUBLESHOOTING.md`, `CONTRIBUTING.md`.
- typesafe_sdk 0.7.1: `__init__`, `constants`, `_core/{endpoints,question_types,response_types}`, `_schemas/models`.
- opencode-jev-orchestrator: `README.md`, `DEVELOPMENT.md`, `docs/OPENCODE_GO.md`, `package.json`, `*.claude.example.json`, `src/{index,types,prompt,jev,policy,adapter,delegate}.ts`, parts of `src/{config,sessions}.ts`, git log (commit `eb5c218` "Replace per-turn parent model switching with a Muse sticky parent").
- Muse Code SDK: `README.md` and a grep of `schema/msp/msp.d.ts` in `/tmp/jev-research/muse-code-sdk`, plus issue #4 on meta-models/muse-code-sdk.

Runs, all free: `scripts/test_policy.py` 9/9 pass. `dry_run.py` with `enabled: false`: 5x `proceed_full`, `jev_used: false`. `dry_run.py` with `enabled: true` and no key: exits with `TYPESAFE_API_KEY is missing`. A mocked end-to-end `route_task` run. OpenCode `npm test`: 76/76 pass. No live Jev calls.

### Boundaries (what the playbook needs from the host agent; what Muse provides or does not)

**Most important finding: "Muse/Hatch" in this playbook is Meta's personal agent Muse, not Muse Code.** Hatch is Muse's internal codebase name. The playbook never mentions Muse Code; `grep -i "muse code"` returns nothing. The examples (flight prices, scraping, refund emails, browser checkout) are personal-agent tasks.

**What "the credential is already connected" means (Track B):**
- `custom.typesafe-ai` is a Muse Custom Connector credential. It lives in Muse's Secure Credentials Store (`hatch-authd`).
- The agent's code only sees a surrogate token. Sentinel, a separate host-side process that is "the sole permission authority for all egress", swaps in the real key at the network boundary.
- So in Track B the agent makes the HTTP call through its own tooling and never holds the key.
- Meta's security blog describes no user-configurable pre-action hook, interceptor or policy extension in the personal Muse agent loop. Its extension surface is MCP, custom connectors, skills and CLIs.
- That explains why this playbook is a skill plus policy and says "this skill is a policy, not a hook": on the personal Muse agent, a skill is the only lever available.

**Muse Code (the terminal agent) does have extension points:**
- Hook events (per dev.meta.ai/docs/muse-code/extending): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PreLLMCall`, `PostLLMCall`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Notification`, `Stop`, `SessionEnd`.
- Hook config locations: project `.muse/hooks.json`, a user settings `hooks` block, and `managed_hooks_path`.
- Other settings: MCP (`mcp_servers`, stdio or streamable_http), `agents.execution_capacity` (1-64, default 8).
- Skills: read from `.agents/skills`, `~/.agents/skills`, and also the legacy `~/.claude/skills`.
- Other surfaces: a plugin system, `muse exec` for headless runs, and the `@muse-code/sdk` TypeScript SDK over the Muse Session Protocol (Developer Preview, pre-1.0). The protocol exposes `approval/decide` with `ApprovalMode` values `allowAll`, `promptUnmatched`, `onRequest`, `denyUnmatched`.
- Caveats from reality versus the docs: a third-party blog (Agentic Control Plane, testing v0.2.1) found that the documented `muse hooks` CLI is missing, that `.muse/hooks.json` was silently ignored, and that hooks shipped as plugin capabilities behind `MUSE_EXPERIMENTAL_PLUGINS=1`. It reports the stdin/stdout contract is exactly Claude Code's (`hook_event_name`, `tool_name`, `tool_input`, `permissionDecision` deny/ask/allow, exit 2 blocks). Issue #4 on meta-models/muse-code-sdk (muse 1.0.3) confirms hooks fire through the settings `hooks` block and `managed_hooks_path` with Claude-compatible stdin. It also confirms hooks run with a cleared environment: only HOME, PATH, USER and similar survive. An exported `TYPESAFE_API_KEY` would not reach a Jev hook in Muse Code.
- The playbook itself uses none of these Muse Code hooks.

**What the playbook needs from the host:** the agent must wake, load the skill, and choose to call Jev; somewhere to make the HTTP call; the discipline to build the 8-field state; a place to append JSONL; honoring `action` voluntarily. It gets no enforcement, no pre-wake interception, no model switching, and no tool blocking.

### Non-obvious things

- Recipes are documentation only. The CLI always sends `build_questions()`. Recipe-specific questions never reach Jev in Track A.
- Key mismatch in the recipe state templates. Templates use `has_cached_artifact`, but `normalize_state` reads `cached_artifact`. Feeding a template with `has_cached_artifact: true` turns it into `False` (verified), which silently disables the `reuse_cache` rule.
- The 0.80/0.50 policy band is never read. `policy.act_min` and `policy.surface_min` are not read by any code. The three-band policy exists only in prose.
- The policy applies "confidence" to nouls, which have none. Jev's noul answer only has P(yes).
- Safety ordering in the code contradicts the docs. `ask_human` for `account` sits below `reuse_cache` and `stop_retry`.
- Low-confidence research still gets capped. Test case 8 asserts that 0.4-confidence research gets `research_capped`, contradicting the "<0.50 escalate" prose.
- Failure handling contradicts the docs. Docs say "on error/timeout fall back and log `jev_used:false`". The code has no fallback: a timeout raises and a missing key exits.
- The kill-switch path logs the goal, and the logger stores raw user content (`goal[:300]`), both against the docs.
- Broken references: QUICKSTART references `skill/jev-usage-router.SKILL.md` (missing); docs/measurement.md promises an aggregation sketch in `ab-template.json` (none); README says A/B numbers are from one local run but `ab-template.json` is all `null`.
- Bypass matching is a plain substring check.
- OpenCode is a different shape of Jev use. One tier question per user message, never intent or retries. Confidence floor 0.3. "Easy" means the tier is not in `escalateOn` (`[strong, long]`). "Hard" means a tier in `escalateOn` at confidence >= 0.3. "Unsure" means confidence < 0.3 or Jev unavailable, which leads to stay. Precedence in `decideAction`: override regex ("use luna") -> parallel-intent regex -> strong-streak branch -> Jev unavailable -> stay -> low confidence -> stay -> tier in `escalateOn` -> escalate -> stay. The three 0-9 score metrics are logged, never decided on.
- Why OpenCode never swaps the parent (commit `eb5c218`, `docs/OPENCODE_GO.md`): switching models per turn throws away the provider prompt cache and burns the scarce per-model quota of the strong model. So `chat.message` always forces `applyModel(stickySelected)` and only injects a synthetic hint telling the cheap parent to call `jev_escalate`. Compliance is voluntary: if the parent ignores the hint, `consumeEscalateMiss` only logs a warning. The child gets the parent transcript (up to 200KB, only the delta on resume) and returns its last assistant text as the tool result.
- OpenCode hardening: project config cannot remap tier models unless global config sets `allowProjectModels`. Prompts are stripped from history by default (`retainPrompt: false`). Child sessions are marked internal so the hook doesn't route them.

### What would NOT transfer to Claude Code and why

- Track B's credential model. Claude Code has no connector store or egress-side credential swap. A Claude Code layer holds a real key. The "agent never sees the key" guarantee can only be approximated by keeping the key inside an MCP server or hook process.
- "Policy, not a hook" as a design constraint. That was forced by the personal Muse agent, not by Jev. Claude Code has real interception points (`UserPromptSubmit`, `PreToolUse` with `updatedInput`, `Stop`, `SubagentStop`, `PostToolUse` failure data). Claude Code hooks inherit the environment, unlike Muse Code's cleared environment.
- Pre-wake savings. Neither Muse nor Claude Code lets Jev run before the main model is invoked on a turn. Muse Code's `PreLLMCall` has no Claude Code equivalent.
- The intent taxonomy and the six recipes assume a browsing and research agent. Generic (keep): `approval-gate`, `retry-gate`. Partly transfer: `triage` (the `coding` intent falls to `proceed_full`), `rank-options`. Personal-agent specific (drop): `research-cap`, `act-or-wait`. A coding version needs different gates: blast radius of an edit, test failing again with the same error, destructive git or shell commands, "is this a trivial edit", "delegate to a subagent/stronger model". OpenCode's `model_tier` criteria (`fast`/`balanced`/`strong`/`long` with coding `signals` and `not_for`) are the closest existing coding-shaped question.
- OpenCode-specific mechanics: the `chat.message` hook that rewrites `output.message.model` (Claude Code hooks can't change the session model per turn); `client.session.create/prompt/status/messages` for child sessions (Claude Code equivalent is subagents with `model` in agent frontmatter, and the parent still has to choose to call it); `tool()` registration (an MCP server in Claude Code); TUI toasts, `/jev-*` commands, OpenCode Go quota and DeepSeek-peak logic.
- The Python router as a module would need wrapping as a hook script or MCP server, a timeout and fallback, and a much tighter deadline than the SDK's 10s default. OpenCode uses 1.5s/3s because it sits on the critical path of every prompt.

### Open questions

- The exact `route.action` -> behavior mapping for shadow mode in Claude Code: log-only hook versus `additionalContext` advice.
- Would the precedence be kept, or put `ask_human` first?
- For noul-based gates, what does "confidence" mean? Distance from 0.5? The playbook never defines it.
- Where would a Claude Code layer get `same_error_count` and `has_cached_artifact` from? `PostToolUse`/`PostToolUseFailure` hooks could count errors mechanically.
- The "~1 second, fraction of a cent" claims come only from the playbook's prose. The SDK returns `usage.input_tokens`, which could be logged for real cost measurement.

Sources: https://dev.meta.ai/products/muse-code/ , https://dev.meta.ai/docs/muse-code/extending , https://dev.meta.ai/docs/muse-code/hooks (behind SSO), https://agenticcontrolplane.com/blog/muse-code-acp-integration , https://github.com/meta-models/muse-code-sdk (issue #4), https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse , https://parallel.ai/articles/meta-muse-custom-integrations
