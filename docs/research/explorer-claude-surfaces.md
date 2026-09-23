# Explorer 3: Claude Code integration surfaces, and how the four existing Claude + Jev projects use them

Verified against the docs for the installed version (2.1.280) and the code of all four repos. Ran the jev-axi fast path, both redactors, and the jev-router override regex under Node 24 to confirm the bugs listed.

Three of the brief's premises are wrong:
- **jev-axi is not fail-closed by default.** It only blocks on an HTTP 403 from the API. A timeout, a network error, a missing key or a bad key (401) all let the call through the normal flow.
- **jev-agent-hooks has no SubagentStart gates.** It gates subagents in PreToolUse on the `Agent` and `Workflow` tools, plus a regex check on SubagentStop.
- **A SubagentStart hook cannot deny anything.** It can only add context.

## Components found

Hook handler types (hooks.md):

| Type | What it does | Default timeout |
|---|---|---|
| `command` | Runs a process. Event JSON on stdin; exit code and stdout carry the result | 600 s |
| `http` | POSTs the event JSON. Non-2xx, connection failure and timeout are all non-blocking; can only block through a 2xx JSON body | 600 s |
| `mcp_tool` | Calls a tool on an already-connected MCP server. `input` supports `${tool_input.x}`; skipped on SessionStart at launch and on Setup | 600 s |
| `prompt` | Single-turn Claude call. Haiku by default ("a fast model"), `model` can override. Must return `{ok, reason, impossible?}`; `continueOnBlock` optional | 30 s |
| `agent` | Experimental. Multi-turn subagent with Read, Grep, Glob, up to 50 turns. Same `{ok, reason}` shape | 60 s |

- `command`/`http`/`mcp_tool` default drops to 30 s on UserPromptSubmit, PreModelSwitch and PostModelSwitch.
- `prompt` and `agent` handlers are allowed on UserPromptSubmit, PreToolUse, PostToolUse, Stop and SubagentStop. Not on SubagentStart, PreCompact or PreModelSwitch.

Plugin packaging:
- `hooks/hooks.json` merged with user and project hooks. `skills/`. `agents/` loaded as `plugin:name`; plugin agents honor `model` and `effort` but ignore `hooks`, `mcpServers` and `permissionMode`. `.mcp.json` servers become `mcp__plugin_<plugin>_<server>__<tool>`; an `mcp_tool` hook refers to the server as `plugin:<plugin>:<server>`. `bin/` is added to PATH.
- **A plugin's `settings.json` only supports `agent` and `subagentStatusLine`**, so a plugin cannot ship permission allow/ask/deny rules.
- `${CLAUDE_PLUGIN_ROOT}` changes on every plugin update. `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) persists.
- `userConfig` with `sensitive: true` stores values in the Keychain (~2 KB). Values reach hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`, or `${user_config.KEY}` in exec-form hooks only.
- Install: `/plugin marketplace add owner/repo` (reads `.claude-plugin/marketplace.json`), then `/plugin install name@marketplace`.

Agent SDK hooks: same events as in-process callbacks (`options.hooks: {PreToolUse: [{matcher, hooks: [cb], timeout}]}`), same JSON shape. Python lacks PreModelSwitch, PostModelSwitch, SessionStart, PostCompact. Timeout behavior differs from CLI: a timed-out PreToolUse callback **blocks** the tool call; a timed-out UserPromptSubmit callback **blocks** the prompt; a timed-out Stop counts as no decision. SDK host can change the main model with `set_model` (goes through PreModelSwitch with `source:"sdk"`). SDK `classifierContext` notes carry more weight with the auto-mode classifier than CLI hook notes.

## Flow

PreToolUse end to end:
1. Matcher runs against `tool_name`. Plain names exact; anything else unanchored JS regex. Optional `if` field (one permission rule such as `Bash(rm *)`) is best-effort.
2. All matching handlers run in parallel. Stdin: `{session_id, prompt_id, transcript_path, cwd, scratchpad_dir, permission_mode, effort:{level}, hook_event_name, tool_name, tool_input, tool_use_id, [agent_id, agent_type in subagents], [mcp_server:{name, source}]}`. For Write/Edit/Read, `file_path` is absolute. For `Agent`, `tool_input` has `prompt`, `description`, `subagent_type`, `model`.
3. Output: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask|defer","permissionDecisionReason":"...","updatedInput":{...},"additionalContext":"..."}}` plus universal `continue`, `stopReason`, `systemMessage`, `terminalSequence`. Precedence across hooks: deny > defer > ask > allow. Deny reason goes to Claude; allow/ask reasons go to the user. `updatedInput` replaces the whole input and permission rules are re-evaluated against it. `defer` only in `-p` mode with a single tool call.
4. Exit codes: exit 2 blocks (stderr as reason; JSON cannot override). Exit 1 or other without valid JSON is non-blocking. **A timeout discards output and the call proceeds through the normal permission flow, so a slow gate fails open.** Missing script (127) also proceeds.
5. The permission engine then evaluates deny and ask rules regardless of the hook. Hook `allow` skips only the prompt. `rm` against critical paths is never auto-approved.

UserPromptSubmit end to end:
1. No matcher. Stdin: `{...common, prompt}`. Pasted text arrives expanded, possibly in `<pasted_content>` markers.
2. Default timeout 30 s. On timeout, output discarded and the prompt goes through without the context.
3. Output: plain stdout or `hookSpecificOutput.additionalContext` (max 10,000 chars) injected as a system reminder. `decision:"block"` plus `reason` erases the prompt (reason shown to user, not Claude). `sessionTitle`, `suppressOriginalPrompt` accepted. **It cannot rewrite the prompt and cannot pick the model.**
4. `additionalContext` should be plain statements of fact. Text phrased as system commands can trigger Claude's prompt-injection defenses.

Other events:
- PostToolUse gets `tool_input`, `tool_response`, `duration_ms`. Output: `decision:"block"` with `reason` (added next to the result), `additionalContext`, `updatedToolOutput` (must match the tool's shape), `classifierContext`. Can't prevent anything.
- SubagentStart gets `agent_id`, `agent_type`. **Can't block;** only `additionalContext`.
- SubagentStop gets `stop_hook_active`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons`. `decision:"block"` keeps the subagent running with `reason` as next instruction.
- Stop works the same; Claude Code forces the stop after 8 consecutive blocks.
- PreCompact gets `trigger`, `custom_instructions`. Exit 2 or `decision:"block"` blocks compaction.
- PreModelSwitch (v2.1.251+): stdin `from_model, to_model, requested_model, source(command|picker|sdk), context_tokens, prompt_cache_warm, cache_ttl, estimated_cache_write_usd, pricing`. `permissionDecision` allow/deny/ask. `ask` counts as refusal everywhere except interactive `/model`. **A timeout blocks the switch.** Doesn't fire for automatic fallbacks or resume restores.

## Files read

Docs in /tmp/jev-research/docs/: `hooks.md`, `permissions.md`, `permission-modes.txt`, `plugins.md`, `plugins-reference.md`, `plugin-marketplaces.md`, `discover-plugins.md`, `sub-agents.md`, `agent-sdk_hooks.md`, `settings.md`.
jev-axi: `src/commands/hook.ts`, `src/safety.ts`, `src/client.ts`, `src/recipes/questions.ts` (284-330, 379-390), `src/supervise.ts`, `README.md`.
jev-use: `src/dispatch.ts`, `src/judge.ts`, `src/redact.ts`, `src/cli.ts` (60-300), `src/protocol.ts` (232-259), `src/backends/{http,typesafe,unconfigured,index}.ts`, `.claude-plugin/*.json`, `.mcp.json`, `harness/claude-code/{gate.hooks.json,README.md}`, `skills/jev-use/SKILL.md`, `bench/RESULTS.md`.
jev-agent-hooks: every file under `hooks/`, `config/claude-settings.snippet.json`, `install.sh`, `agents/*.md`, `skills/claude-subagent-model/SKILL.md`, `README.md`.
jev-router: `src/proxy.mjs`, `src/router.mjs`, `src/policy.mjs`, `src/config.mjs`, `src/settings.mjs`, `src/status.mjs`, `bin/jev-claude.mjs`, `docs/jev-claude-architecture.md`.

## Boundaries

| Surface | Enforce | Advise / shape |
|---|---|---|
| Permission deny/ask rules (settings, managed) | Hard deny or ask. Evaluated after hooks, even when a hook returned allow. `Agent(model:opus)` and `Agent(Explore)` rules can gate subagent tier and type | none |
| PreToolUse (command/http/mcp_tool) | deny or exit 2 (beats allow rules), ask, `updatedInput` rewrite (can set `Agent.model`) | `additionalContext` |
| PreToolUse (prompt/agent) | `ok:false` denies; ends the turn unless `continueOnBlock` | none |
| UserPromptSubmit | Block or erase the prompt only | `additionalContext` (can't rewrite the prompt or choose the model) |
| PostToolUse | Nothing; the tool already ran | `updatedToolOutput` rewrites what Claude sees, `additionalContext`, `classifierContext` |
| SubagentStart | None | `additionalContext` to the subagent |
| SubagentStop / Stop | Force continuation (block plus reason; Stop capped at 8) | `additionalContext` |
| PreCompact | Block compaction | none |
| PreModelSwitch | allow, deny or ask on user or SDK switches; a timeout blocks | `systemMessage` |
| PostModelSwitch | None | `additionalContext` |
| Agent definition `model:` | Fixed tier unless Claude passes a per-invocation `model` (which wins) | none |
| `CLAUDE_CODE_SUBAGENT_MODEL` (+`_FORCE=1`) | FORCE puts every subagent on one model, ignoring frontmatter and per-call `model` | none |
| `ANTHROPIC_BASE_URL` proxy | Rewrites the model on each request (the only way to route per turn in the CLI) | none |
| SDK `set_model` / callbacks | Host sets the model; callback timeouts on tool or prompt gate fail closed | none |

Subagent model control: SubagentStart can only add context. Model resolution order: per-invocation `model` parameter, then frontmatter `model:`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. Enforcement therefore lives in PreToolUse on `Agent`: deny, or `allow` plus `updatedInput.model` (not tested live). `Agent(model:...)` ask/deny rules also work. For the main session, no hook can set the model. Only an `ANTHROPIC_BASE_URL` proxy, `--agent` at startup, or SDK `set_model`.

## Existing projects

**jev-axi (shiftynick)**
- Surface: PreToolUse command hook written into `settings.json` by `configureSafetyHook` (`src/commands/hook.ts:249-269`), matcher `Bash|Write|Edit|MultiEdit`, 15 s timeout. Also a Stop hook and a PostToolUse supervision hook. Not a plugin.
- Jev call: 6 s budget, no retries (`hook.ts:45`, `:117`).
- Questions (`src/recipes/questions.ts:284-330`): five nouls (`destructive`, `exfiltration`, `remote_code`, `weakens_security`, `outside_project`) plus a `risk` score 0 to 2.
- Thresholds (`safety.ts:247-261`): deny if any of the four blocking hazards >= 0.8; deny if top hazard >= 0.8 and risk >= 1.5; ask if any hazard >= 0.45 or risk >= 1.5.
- Output (`safety.ts:281-286`): allow prints nothing (never auto-approves); ask/deny emitted as `permissionDecision`.
- Local fast path: `localVerdict` (`safety.ts:158-192`). Every tool outside Bash and the edit tools is allowed locally.
- Failure mode (`hook.ts:125-133`): `auto` means deny on 403 (the TypeSafe web firewall rejects bodies containing literal attack commands), allow on everything else including a missing or bad key.
- Latency: ~375 to 402 ms per call in README examples. 44 of 44 labeled cases passed on 2026-09-23.
- Problems confirmed by running the code: `splitSegments` (`safety.ts:103`) doesn't split on `&`, so `ls & rm -rf ~` is decided "allow" locally and Jev never sees it. `sed -Ei`, `find -fprintf`, `sort -o ~/.bashrc`, `git diff --output=...` and `cd / && rm -rf tmp` are all "routine". **Truncation happens before redaction** (`safety.ts:216, 226`): content is cut to 3,000 chars first; a PEM key straddling the cut loses its END marker and 2,864 raw key chars were sent in the test. Redactor misses `AIza`, `glpat-`, `npm_`, `ASIA`, `hf_`, `-p<password>`, `--password x`. Matcher omits `NotebookEdit`, `PowerShell`, `WebFetch`, MCP tools. The user prompt in `job` is never redacted.

**jev-use (shitianfang)**
- Surfaces: marketplace plugin with an MCP server (`npx -y jev-use@0.8.0 serve`) exposing `jev_judge` and `jev_gate`; a routing skill; an opt-in PreToolUse gate in `harness/claude-code/gate.hooks.json` (matcher `Bash|Write|Edit`, 30 s timeout). The plugin does not install the hook. `dispatch.ts` screens questions structurally and escalates low-confidence answers.
- Question (`judge.ts:191-244`): a single `choice` allow vs deny, "Should the agent be allowed to run this proposed action right now?".
- Thresholds: escalate below reported confidence 0.5 or estimated margin 0.4 (`protocol.ts:232, 246`). Noul certainty is |p - 0.5| x 2. State capped at 30k tokens (`protocol.ts:259`); larger escalates.
- Output (`cli.ts` hookGate ~160-199): allow silent, deny -> deny, escalate -> "ask".
- Failure mode: no key -> `createBackend` throws -> fails open. Backend error -> ask. In `-p` or `dontAsk`, ask becomes deny. **Worst-case outage is 3 x 10 s attempts plus backoff** (`backends/http.ts:13-14`, Retry-After up to 60 s), more than the 30 s hook timeout, so the hook is killed and the call proceeds, contradicting the comment "never waved through". Harness README says "fails open"; `cli.ts` says unreachable -> ask.
- Latency: p50 223 ms, p95 364 ms per call. Shipped hook 0.71 s per decision. 12 batched questions 224 ms vs 2,662 ms sequential. npx resolution adds to every call.
- Redaction (`redact.ts:31-61`): misses PEM private keys, `sk_live_`, `glpat-`, `npm_`, `ASIA`, `hf_`, `-p<password>`. Full `tool_input` JSON is sent, including entire file contents for Write. `JEV_GATE_STATE` sent unredacted.

**jev-agent-hooks (onlyjq04)**
- Surfaces (`config/claude-settings.snippet.json`): UserPromptSubmit, PreToolUse on `Agent|Workflow` and on `Agent`, SubagentStop. Not a plugin; `install.sh` symlinks into `~/.claude/{hooks,skills,agents}` and runs `rm -rf` on existing real directories at the destination.
- Skill suggest (`hooks/jev-skill-suggest.mjs`): request 1 is a choice over the whole roster plus three gate nouls (threshold 0.3, line 21); request 2 a choice over top 3 plus per-skill `fits` noul (threshold 0.7, line 25). Injects `<skill_relevance>` additionalContext. Timeouts 4 s per call, 10 s hook. Measured 2 to 3 s per turn. **Bug at line 126:** checks whether any fits score >= 0.7 but injects the choice winner, which may not be the skill that passed. Prompt (up to 6,000 chars) and last 1,500 chars of assistant text sent unredacted. Roster ignores project `enabledPlugins`; large roster can exceed Jev's 32k and fail silently.
- `subagent-model-gate.mjs`: deterministic, no Jev. Denies `Agent` with no `model`, a model outside `haiku|sonnet|opus|fable`, or a preset agent with the wrong model. Uses deny-and-retry where `updatedInput` would do.
- `jev-agent-gate.mjs`: `fit` noul, deny below 0.2; `tier` choice, deny when choice differs from request, confidence >= 0.5 and P(requested) < 0.15. Denies at most once per session/agent/tier; state in a shared `tmpdir()` file with non-atomic read-modify-write that never expires. Plugin agents indexed by bare name but arrive as `plugin:name`, so fit is skipped for them. Up to 8,000 chars sent unredacted. ~400 ms.
- `subagent-return-gate.mjs`: regex on SubagentStop; blocks empty report or short "still running" with no evidence.
- Failure mode: fails open everywhere.

**jev-router (gargpratyush)**
- Surface (`bin/jev-claude.mjs`): sets `ANTHROPIC_BASE_URL` to a loopback proxy on 127.0.0.1 random port (`proxy.mjs:346`). Registers sentinel model `jev-router` via `ANTHROPIC_CUSTOM_MODEL_OPTION*` and `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`.
- Routing: only the first request of each turn (tools present, no `tool_result`) is routed (`proxy.mjs:55-72`); tier pinned per conversation key. `applyTier` strips `thinking` and `effort` for Haiku.
- Questions (`config.mjs:100-151`): three 10-level scores and a `choice` over the exact model ids in the account's catalog.
- Policy (`policy.mjs:37-62`): prompt override pattern wins; confidence < 0.3 no downgrade and upgrades capped at sonnet; no downgrade once context > 20k tokens; Fable only with `JEV_ALLOW_FABLE=1`.
- Failure mode: Jev errors keep the current model. 1.5 s per attempt, 1 retry, 3 s total (`config.mjs:64-66`); ~300 to 350 ms warm, 900 to 1,000 ms cold.
- Auth: headers forwarded unchanged; no credentials injected.
- Problems: `jev-claude.mjs:127` overwrites any existing `ANTHROPIC_BASE_URL` and upstream is hardcoded to `api.anthropic.com` (`proxy.mjs:19`), so a corporate gateway is silently bypassed. `jev-claude.mjs:75-85` runs `process.loadEnvFile(cwd/.env)` into Claude's environment, so project secrets reach every Bash call and a repo `.env` with `NODE_OPTIONS` gets past workspace trust. Override regex misfires: "with fast path" -> haiku, "use fast-glob" -> haiku, "use strong typing" -> opus, "with long lines" -> fable. Architecture doc says default pin sonnet; code uses opus (`proxy.mjs:216`). When body fails to parse, request is forwarded still carrying the sentinel model name.

## Non-obvious things

- **Every CLI hook family fails open.** A command/http/mcp_tool timeout, HTTP non-2xx, exit 1 and a missing script all let the tool call proceed. Only fail-closed paths: exit 2, explicit JSON, a PreModelSwitch timeout, and SDK callback timeouts on PreToolUse and UserPromptSubmit.
- **A hook can tighten but never loosen deny or ask rules.** Deny/ask rules still apply after a hook allow; exit 2 beats allow rules. Silence plus "allow = print nothing" (jev-axi, jev-use) is the correct shape.
- **Hook "ask" becomes a deny** in `-p` without a permission host, in `dontAsk` mode, and on non-interactive PreModelSwitch.
- **Hooks in plugin agent files are ignored, and plugins cannot ship permission rules.** Hard rules go in user, project or managed settings.
- **Prompt and agent hooks give a no-external-service fallback judge** (Haiku by default, 30 or 60 s) on PreToolUse, UserPromptSubmit, Stop, SubagentStop. Not on SubagentStart, PreCompact, PreModelSwitch.
- **Using `ANTHROPIC_BASE_URL` changes Claude Code's own behavior**, e.g. it skips MCP schema normalization (`proxy.mjs:22-44`), and the UI shows the requested model not the served one.
- In the PostToolUse result for `Agent`, `resolvedModel` and `modelsUsed` show which model a subagent actually ran on.

## Open questions

- Whether `updatedInput` with `permissionDecision:"allow"` on `Agent` reliably changes the subagent's model, and how it interacts with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`. Not tested live.
- How a hook "ask" behaves in `bypassPermissions` mode. Docs don't say.
- Which Haiku a `prompt` hook uses by default, and whether `model:"haiku"` is required to pin it.
- Whether `jev-latest` alias changes shift calibration enough to invalidate thresholds. jev-axi invalidates its cache when the alias moves; none of the repos re-calibrate.
