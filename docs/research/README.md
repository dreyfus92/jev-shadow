# Jev + Claude Code: should a decision layer be built, and what

Date: 2026-09-23. Second pass, run through the pstack Investigation playbook: four explorers (Jev contract, the Muse playbook as code, Claude Code surfaces and the four existing Claude + Jev repos, and an attack on the premise), one synthesizer, a decision trail in `decisions.tsv`, and a cross-model review. The first pass is kept as `jev-claude-research-v1.md`. Raw explorer reports are in `.research/`. Cloned repos and doc copies are in `/tmp/jev-research/`.

## Overview

Jev is TypeSafe AI's "System One" model, released in early access on 2026-09-15. It does not generate text. You POST a text `state` and a map of typed questions to `POST /v1/systemone`, and it answers all of them in one pass with probabilities. A single call measured p50 223 ms and p95 364 ms through the Vercel gateway. The "Muse + Jev" thing you saw is `Bodila51/muse-jev-playbook`. It targets Meta's personal agent Muse (internal name Hatch). It does not target Muse Code, and the repo never mentions Muse Code. That agent has no pre-action hook, so the playbook is a skill plus a Python reference router the agent may choose to call. Its code also contradicts its own docs. The 0.80/0.50 band is never read. There is no fallback on timeout. `ask_human` ranks below `reuse_cache`. Shadow mode and active mode run the same code path.

You do not need a Jev decision layer in your own Claude Code setup. You run `auto` mode on Max. The auto-mode classifier already reviews almost every hazard the existing Jev gates check, at no extra cost on Max. It sees the transcript and strips tool results, so hostile content cannot steer it. Jev adds a third party, 0.2 to 0.9 s per gated call, and an "ask" that forces prompts auto mode would have skipped. For your own sessions, install `typesafe-ai/skills` (and `jev-use` if you want Jev as a tool inside tasks) and keep auto mode as the gate. The smallest thing worth building is a zero-latency shadow harness. It logs Jev's verdicts next to the auto-mode classifier's real denials, in your public OSS repos only. That produces the independent calibration data nobody has yet. It also decides whether the second item is worth doing, which is hardening `jev-axi` upstream for users without auto mode (Manual mode, `dontAsk`, Codex, pi).

## What the first pass got wrong

- "Muse Code has no public hook or plugin API, which is why the Muse + Jev work is skill-only." Both halves are wrong. The playbook targets Meta's personal Muse agent. Muse Code has 15 hook events with Claude-compatible stdin (`.research/explorer-muse-playbook.md`, Boundaries).
- "Claude Code fixes the Muse weakness." Only partly. Neither host lets Jev run before the main model wakes. In `auto` mode, the enforcement Claude Code adds mostly duplicates the classifier.
- The playbook's policy table (>= 0.80 act, 0.50 to 0.79 surface, < 0.50 escalate), its "hard rules" and "fail open, log `jev_used:false`". That is prose only. `policy.act_min` and `surface_min` are never read. `stop_retry` fires on the first repeat. `ask_human` ranks below `reuse_cache` and `stop_retry`. A timeout raises, and a missing key calls `SystemExit`. Redaction is field dropping only, and the kill-switch path logs raw `goal[:300]` (`/tmp/jev-research/muse-jev-playbook/src/router.py:73-126`, verified with a mock run).
- "Shadow mode is the playbook's best idea." In the playbook's code it does nothing, because shadow and active paths are identical. TypeSafe's docs never recommend shadow mode. The idea comes from Flavio Copes and pi-jev-context. Confirmed by grepping `llms-full.txt`, where "shadow" appears only inside example state text.
- `UserPromptSubmit` -> `permissionDecision` deny. It uses top-level `decision: "block"`, which erases the prompt. It cannot rewrite the prompt or pick the model (`docs/hooks.md:1379-1393`).
- `SubagentStart` -> `permissionDecision` deny, input `agent_input`. SubagentStart cannot block and receives only `agent_id` and `agent_type` (`docs/hooks.md:2367, 2380`). Subagent gating belongs in `PreToolUse` with matcher `Agent`.
- `PostToolUse` -> `updatedResult`. The field is `updatedToolOutput` (`docs/hooks.md:2041`).
- `Stop` -> `continue: true` plus reason. Stop continues the turn with `decision: "block"` plus `reason`, or with `hookSpecificOutput.additionalContext`. Both are capped at 8 consecutive continuations (`docs/hooks.md:2620-2633`).
- "`PreCompact`: `triggered_by`, side effects only (score what to keep)." The input field is `trigger`. PreCompact can block compaction but has no way to shape what survives (`docs/hooks.md:3058-3075`).
- "Per-turn main model via proxy or `PreModelSwitch`." PreModelSwitch only allows, denies or asks on switches that a user or the SDK starts. No hook can set the main model. Only an `ANTHROPIC_BASE_URL` proxy, `--agent` at startup, or SDK `set_model` can.
- "Model tiering at the subagent level via `SubagentStart` deny." It has to be `PreToolUse` on `Agent`, using deny or `updatedInput.model`. The `updatedInput.model` path is untested live.
- jev-agent-hooks uses "`UserPromptSubmit` + `SubagentStart`." It uses UserPromptSubmit, `PreToolUse` on `Agent|Workflow`, and a regex `SubagentStop` gate.
- jev-axi "fails closed on 403 by default" and is "best-designed" and "proven." Default `--on-error auto` denies only on HTTP 403. A timeout, network error, or missing or bad key all allow (`jev-axi/src/commands/hook.ts:128`). Running it also found a local fast-path bypass (`ls & rm -rf ~` is "allow", `safety.ts:103`). It truncates before redacting, which leaked 2,864 raw PEM key characters in a test (`safety.ts:216, 226`).
- "Reuse jev-use's `src/redact.ts`." It misses PEM keys, `sk_live_`, `glpat-`, `npm_`, `ASIA`, `hf_` and `-p<password>`. It also sends full Write file contents.
- "Local fast path first keeps p50 near zero" as a design gain. In auto mode the built-in read-only list and allow rules already do this. jev-axi's fast path never approves anything anyway.
- "Stop verify with a noul." `/goal` already does this with a Haiku evaluator over the transcript, up to about 100k tokens. Jev's state cap is 32k tokens.
- Jev reachable through "LiteLLM", model id `jev-1.12`. There is no LiteLLM support in TypeSafe, SDK or gateway docs. `jev-latest` and `jev-preview` both resolve to `jev-1.13.0`. Whether `jev-1.12` still works is unknown.
- Unverified, not overturned. No explorer checked `tamaratran/jev-pruner`, `fast-jev-compaction` or `yibie/awesome-jev`. Treat them as unconfirmed.

## Key concepts

The three Jev primitives.
- `noul` returns only `noul`, which is P(yes). It has no confidence field. The harness has to define certainty itself. jev-use uses `2*|p-0.5|`. TypeSafe's docs use a two-sided band (YES >= 0.8, NO <= 0.2).
- `choice` returns `choice`, `probabilities` and `confidence`. The confidence formula is undocumented. Current doc examples match `(p_top - 1/n)/(1 - 1/n)`, which jev-use confirmed across 318 answers.
- `score` returns a probability-weighted mean of level indices, plus `probabilities` and `confidence`. For more than 2 levels, no function of the distribution that jev-use tried reproduces `confidence`.
- Calibration is claimed across groups of answers only, never for one answer.

Auto mode's classifier. A separate model (Claude Sonnet 5 by default) reviews every action except reads and in-project edits outside protected paths. It also reviews subagent spawns, subagent actions and subagent reports. It sees user messages, tool calls and CLAUDE.md. Tool results are stripped (`docs/permission-modes.md:486, 494-502`). On Max, Claude Code sends these requests itself, and they cost nothing extra. A hook's `"ask"` still forces a prompt in auto mode (`docs/hooks.md:1825`).

Enforce versus advise.
- Enforce. `PreToolUse` can return `permissionDecision` deny, ask, or allow plus `updatedInput`. Exit 2 blocks. `Stop` and `SubagentStop` can force continuation. `PreCompact` can block. Deny and ask rules in settings still apply after a hook allows.
- Advise. `additionalContext` (`UserPromptSubmit`, `SubagentStart`, `Stop`) and `updatedToolOutput` (`PostToolUse`) shape what the model sees but block nothing.
- CLI failure. Every CLI hook type fails open on timeout, non-2xx, exit 1 or a missing script. The SDK differs, where timed-out `PreToolUse` and `UserPromptSubmit` callbacks block.

Shadow mode. Jev is asked, the verdict is logged, and nothing acts on it. In Claude Code the clean way is a command hook with `"async": true`. It runs in the background, and its `decision` or `permissionDecision` output is ignored, so it adds no latency and cannot change the outcome (`docs/hooks.md:3672`). A synchronous hook that exits 0 with no output is the fallback, but it still costs the Jev round-trip.

## How the alternatives compare

| Placement | What Jev adds over the built-in | Latency cost | Trust cost | Evidence quality | Verdict |
|---|---|---|---|---|---|
| `UserPromptSubmit` triage | Little. Fable 5.1 already reads the prompt and picks skills and agents from their descriptions. | One call 0.2 to 0.9 s per prompt. jev-agent-hooks' two-pass design measured 2 to 3 s | Prompt text and recent assistant text go to TypeSafe. jev-agent-hooks sends them unredacted | Weak. The three gate nouls "barely separate" (0.44 to 0.92 overlap). Labels were the agent's own choices | Drop |
| `PreToolUse` tool gate | In auto mode, almost nothing. The five hazards map onto the classifier's block list. Outside auto mode, a probability-scored second opinion | 375 to 402 ms (jev-axi README), 0.71 s per decision (jev-use hook) | High. Commands, paths and script contents leave the machine. Script contents can be attacker-written | Moderate. jev-axi 44/44 author-labeled cases. jev-use gate 80.9% agreement, all errors over-refusals | Drop in auto mode. Harden jev-axi for others |
| `PreToolUse` `Agent` tier gate | A tier `choice` over the task prompt. The rule part needs no model | ~400 ms | Task prompt, up to 8,000 chars unredacted in jev-agent-hooks | Thin. 20 dispatches. The fit question never fired | Deterministic rules plus frontmatter `model`/`effort` plus `Agent(model:...)` rules. Jev in shadow only |
| `Stop` verify | Nothing. `/goal` reads the transcript, Jev caps at 32k | Per turn. A false "continue" costs a full Fable turn | Final message goes to TypeSafe | None for Jev | Use `/goal` when needed |
| `PostToolUse` output pruning | The only row with no built-in model option. A `prompt` hook cannot return `updatedToolOutput` | One call per large output | High. Reads raw tool output, the adversarial input the classifier deliberately strips | Negative. jev-use keep-or-drop scored 56.3% against a 68.7% majority baseline | Shadow experiment at most |
| `PreCompact` scoring | Nothing usable. PreCompact can only block, not shape the summary | n/a | Transcript to TypeSafe | Same 56.3% keep-or-drop result | Drop |
| Per-turn routing via proxy (jev-router) | The only way to change the main model per turn in the CLI | 300 to 350 ms warm, 900 to 1,000 ms cold, plus uncached rebuilds on each upgrade | Highest. Sits on the auth path, overwrites `ANTHROPIC_BASE_URL`, loads the repo `.env` into Claude's environment | Weak. Override regex misfires, the doc and code disagree on the default pin | Drop. Use effort, which keeps the cache on Fable 5.1 |
| Skill-only advisory layer (Muse playbook port) | Nothing the main model lacks. It is voluntary, and the main model is the stronger judge | Main-model tokens plus a call when chosen | Depends on what the model sends | The playbook's code contradicts its docs. It exists only because personal Muse has no hooks | Install `typesafe-ai/skills` only. Don't port |
| MCP tool the model calls | Cheap batched typed judgments inside a task (12 questions in 224 ms against 2,662 ms sequential) | Zero unless called | The model chooses what to send | Moderate. 82.2% agreement with a claude-opus-5 reference against a 68.7% baseline. Haiku 35/45, Jev 33/45 | Already exists (`jev-use` `jev_judge`/`jev_gate`). Install if wanted, don't build |

Three rows need more than the table.

PreToolUse tool gate. The synthesizer agrees with the premise attack that it is redundant in auto mode. Two things tip it. A Jev `ask` turns a silent classifier approval into a prompt, and every gate error jev-use measured was an over-refusal. And Jev reads script contents, which TypeSafe's jaggedness page says can steer it ("does not treat it as hostile by default"). Keeping jev-axi as is for non-auto sessions is not acceptable either. The `&` bypass and the truncate-before-redact leak have to be fixed first.

PostToolUse pruning. The premise attack calls this "the only place Jev clearly wins". The synthesizer disagrees. It is the only row where no built-in model can do the job. But the only direct measurement is below the always-guess-the-majority baseline. Large outputs, the ones worth pruning, also run into the 32k state limit. It is an experiment, not a win.

Proxy routing. Beyond the cache cost, pointing `ANTHROPIC_BASE_URL` at a proxy changes Claude Code's own behaviour. MCP schema normalization is skipped. Tool search becomes unavailable, so MCP tools load into the cached prefix (`docs/prompt-caching.md:114`). Auto mode can fall back to client-side classifier requests (`docs/permission-modes.md:319`).

## Recommendation

For your own sessions, build nothing new. Install `typesafe-ai/skills` (`claude plugin marketplace add typesafe-ai/skills`, then `claude plugin install typesafe@typesafe-ai`) so Claude writes correct Jev calls. Its migration link 404s. Install `jev-use` only if you want Jev as a tool for bulk typed judgments inside a task. Keep auto mode as the gate. Add `permissions.ask` rules for your own boundaries, for example `Bash(git push *)`, since auto mode allows pushes by default (`docs/permission-modes.md:404, 418`). Do not run any Jev gate synchronously.

1. Shadow harness (build this; small; for your own OSS sessions).
- Surface. Three command hooks, all `"async": true`. `PreToolUse` on `Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*` asks Jev. `PermissionDenied` records the classifier's denial. It carries `tool_use_id` and a rule label such as `[Data Exfiltration]`. `PostToolUse` records that the call ran. Joining on `tool_use_id` gives a labeled pair for every gated call. This join is the synthesizer's addition. No explorer proposed it.
- Question pack. jev-axi's five nouls (`destructive`, `exfiltration`, `remote_code`, `weakens_security`, `outside_project`) plus the `risk` score, pinned to `jev-1.13.0`.
- Failure mode. It cannot block, so fail open by construction. Still set SDK `retry.maxRetries: 0` and an `AbortSignal` deadline so background processes don't pile up.
- Redaction. Redact first, then truncate. Cover PEM, `sk-`/`sk_live_`, `AIza`, `glpat-`, `npm_`, `AKIA`/`ASIA`, `hf_`, `-p<password>` and `--password x`. Keep SDK `logLevel` at `warn`, because `debug` logs bodies unredacted. Enable it only in public OSS repos through `enabledPlugins` in `.claude/settings.local.json`. Never enable it in the santa-ia client repos.
- Measure. Per hazard, agreement between "any hazard >= 0.8" and a classifier denial. Over-refusal rate (Jev >= 0.45 where the classifier allowed). The accuracy of the >= 0.8 band. Authenticated p50 and p95 from your Mac, which is still an open question. The classifier is a reference, not ground truth.
- Promotion. None for your auto sessions. The log is the evidence for item 2.
- Legal. Log for evaluation only. MCA 2.3(b) forbids training a model to imitate Jev's output.

2. Harden jev-axi upstream (build if item 1 shows usable agreement; small PRs; for Manual mode, `dontAsk`, Codex and pi users).
- Surface. Synchronous `PreToolUse` command hook. jev-axi already supports `--agent claude|codex`.
- Question pack. Unchanged.
- Fixes. Split on `&` in `splitSegments`. Redact before truncating. Add the missing redaction patterns. Redact the `job` prompt. Widen the matcher to `NotebookEdit`, `PowerShell`, `WebFetch` and `mcp__.*`. Close the fast-path gaps (`sed -Ei`, `find -fprintf`, `sort -o`, `git diff --output`). Optionally ship it as a plugin (`hooks/hooks.json` plus `bin/`) for easier install.
- Failure mode. Keep fail-open as the default. A Manual-mode user still sees the normal prompt, and a slow gate fails open anyway because of CLI hook timeouts. Document that `--on-error deny` or `ask` becomes a hard deny in `dontAsk` and `-p`.
- Redaction. As in item 1.
- Measure. The 44 labeled cases plus item 1's joined log. Promote a hazard to deny only when its >= 0.8 band agrees with the classifier's category on that log.

3. PostToolUse pruning (experiment only). Add it to item 1 as a shadow question: what share of lines Jev would drop, compared with what the model later cited. Build nothing active unless it beats the 68.7% majority baseline.

Not recommended. Triage, Stop verify, PreCompact, proxy routing, a port of the Muse playbook, a new MCP server.

File layout for item 1:

```
jev-shadow/
  .claude-plugin/plugin.json   # userConfig: typesafe_api_key (sensitive, Keychain)
  hooks/hooks.json             # async PreToolUse, PermissionDenied, PostToolUse
  bin/jev-shadow               # reads stdin, redacts, calls Jev, appends to ${CLAUDE_PLUGIN_DATA}/log.jsonl
  src/redact.ts
  src/questions.ts             # jev-axi pack, model pinned to jev-1.13.0
  scripts/report.ts            # join on tool_use_id, agreement, band accuracy, latency
```

## Gotchas

- Noul confidence gap. Nouls return only P(yes). A policy that applies "confidence" to a noul, as the playbook does, is undefined. Pick `2*|p-0.5|` or a two-sided band and write it down.
- Undocumented confidence. The choice formula is inferred. The score formula is not reproducible. Jev also answered decisively on borderline cases (8 clear against 8 borderline "did not separate"; escalated verdicts right 51%).
- The SDK has no total time budget. Its `timeout` (10 s default) applies per attempt, with 2 retries, backoff, and honoring `Retry-After` up to 60 s. jev-use's 30 s hook gets killed before its worst case, so it passes the call through despite its "never waved through" comment. Set your own deadline below the hook timeout.
- CLI hook timeouts fail open. Exit 1 and a missing script also let the call proceed. Only exit 2, explicit JSON, a PreModelSwitch timeout, and SDK `PreToolUse`/`UserPromptSubmit` callback timeouts block.
- "ask" becomes deny in `dontAsk`, in `-p` without a permission prompt tool, and on non-interactive PreModelSwitch. In auto mode, a hook "ask" forces a prompt.
- Plugins cannot ship permission rules. A plugin's `settings.json` supports only `agent` and `subagentStatusLine`. Hooks in plugin agent files are ignored. Hard rules go in user, project or managed settings.
- MCA 2.3(b) forbids using Output to "train a model to imitate the output of the Services". Logging verdicts to train a local replacement breaks it. The MCA also grants a perpetual license to derive Telemetry, retention is "as long as necessary", and ZDR on the direct API is enterprise-only.
- Adversarial state. jev-1.13 "does not treat [state] as hostile by default". Any design that feeds Jev script contents, diffs or tool output accepts that risk. The classifier strips tool results for this reason. Don't pipe Jev-derived text into `classifierContext`.
- Alias drift. `jev-latest` "can change without a change on your side". There is no deprecation policy. Pin `jev-1.13.0`. Through Vercel the response `model` is unversioned (`typesafe-ai/jev`), so drift can't be detected there.
- Redaction changes verdicts. In jev-use, 5 of 6 kept direction, and a benign health check flipped from deny to allow. Measure with redaction on.
- Run-to-run variance. Up to 0.08 movement on identical input (OpenRouter cookbook). In jev-use, 20 escalation flags flipped at the threshold.
- Access. The direct API is waitlisted. The Vercel gateway has none, and jev-use saw $0 billed there.

## Open questions

- Real authenticated Jev latency from your Mac. Probes only reached rejection paths (median about 0.69 s). Item 1 answers this.
- Whether Jev's hazard probabilities agree with any independent reference. No calibration study exists. Item 1 gives a partial answer.
- Whether `updatedInput.model` with `allow` on `Agent` reliably changes the subagent model, and how it interacts with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`. This decides whether a tier gate can rewrite or only deny.
- Non-enterprise retention and ZDR, and whether Vercel ZDR applies on the `/typesafe` path. This decides whether any of this can run on private code.
- Whether a `jev-latest` alias move shifts calibration enough to invalidate tuned thresholds.
- How a hook "ask" behaves in `bypassPermissions`.
- Auto-mode classifier latency on Max, which is undocumented. It sets the bar a Jev gate must beat.
- `autoMode.environment` in `~/.claude/settings.json` reportedly describes only cargo-diet. It is global, so the classifier you rely on gets cargo-diet context in every repo. Worth checking regardless of Jev.

## Sources

TypeSafe and Jev
- https://docs.typesafe.ai (api, models, confidence, primitives, concepts, model-jaggedness/jev-1.13, sdk, legal), https://docs.typesafe.ai/llms-full.txt, https://docs.typesafe.ai/migrating-to-v1.md (404)
- https://api.typesafe.ai/openapi.json
- https://typesafe.ai, https://typesafe.ai/blog/introducing-system-one-models-and-jev
- https://typesafe.ai/legal/mca, https://typesafe.ai/legal/privacy-policy, https://typesafe.ai/legal/data-processing
- https://github.com/typesafe-ai/typesafe-sdk-js, npm `@typesafe-ai/sdk@0.6.0`, PyPI `typesafe-sdk` 0.7.1
- https://github.com/typesafe-ai/skills

Gateways and articles
- https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
- https://openrouter.ai/typesafe/jev-latest, https://openrouter.ai/docs/guides/community/typesafe-sdk, https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev
- https://www.eigent.ai/blog/typesafe-ai-jev-system-one-models, https://flaviocopes.com/jev/, https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/
- https://github.com/browser-use/jev-ultrafast (docs/performance.md)

Claude + Jev and adjacent projects
- https://github.com/shiftynick/jev-axi
- https://github.com/shitianfang/jev-use
- https://github.com/onlyjq04/jev-agent-hooks
- https://github.com/gargpratyush/jev-router
- https://github.com/aaronshaf/opencode-jev-orchestrator
- https://github.com/Bodila51/muse-jev-playbook, https://github.com/Bodila51/grok-bot-jev
- https://github.com/Nyarlathoteppppp/pi-heed, https://github.com/Nyarlathoteppppp/pi-jev-context

Muse
- https://dev.meta.ai/products/muse-code/, https://dev.meta.ai/docs/muse-code/extending, https://dev.meta.ai/docs/muse-code/hooks (behind SSO)
- https://github.com/meta-models/muse-code-sdk (issue #4)
- https://agenticcontrolplane.com/blog/muse-code-acp-integration
- https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
- https://parallel.ai/articles/meta-muse-custom-integrations

Claude Code docs (2.1.280, local copies in `/tmp/jev-research/docs/`)
- https://code.claude.com/docs/en/ pages: `hooks`, `hooks-guide`, `permissions`, `permission-modes`, `auto-mode-config`, `plugins`, `plugins-reference`, `plugin-marketplaces`, `discover-plugins`, `sub-agents`, `agent-sdk/hooks`, `settings`, `prompt-caching`, `skills`, `goal`, `costs`, `model-config`, `data-usage`, `sandboxing`
- The prompt-hook evaluator extracted from the 2.1.280 binary is at `/tmp/jev-research/prompthook.txt`.
