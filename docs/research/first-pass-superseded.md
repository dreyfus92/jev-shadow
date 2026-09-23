# Jev + Claude: research notes

Date: 2026-09-23. Jev was released in early access on 2026-09-15, so everything below is one week old and vendor-reported unless marked otherwise.

## 1. What the two things are

**Jev** (TypeSafe AI) is a "System One" model. It does not generate text. You POST a `state` (any text or JSON) plus a map of typed questions, and it returns every answer in one parallel pass with a calibrated probability. Three primitives:

| Type | Input | Output |
|---|---|---|
| `noul` | yes/no instruction | `noul: 0..1` (P(yes)) |
| `choice` | instruction + `criteria: {key: description}` (up to 255) | `choice`, `probabilities`, `confidence` |
| `score` | instruction + ordered `criteria: [level0, level1, ...]` (2 to 10 levels) | decimal `score` (e.g. 1.05), `probabilities`, `confidence` |

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest` (also `jev-1.13.0`, `jev-1.12`).
- SDKs: `@typesafe-ai/sdk` (TS, `new TypeSafeClient({apiKey})`, `client.systemOne({model, state, questions})`) and `typesafe-sdk` (Python, `TypeSafeClient().system_one(...)`). Auth is `TYPESAFE_API_KEY`, keys from console.typesafe.ai/keys. Also reachable through OpenRouter (`typesafe/jev-1.13`), LiteLLM, and Vercel AI Gateway.
- Pricing/latency claims: $0.042 per 1M input tokens, free output, 70 to 500 ms. Community measurements: p50 ~230 ms and ~$0.02 per 1,000 judgments (jev-use), ~400 ms for a subagent-routing question (jev-agent-hooks). Nobody independent has reproduced the "200x faster / 400x cheaper" headline.
- Limits: text only, no world knowledge (judges only what you put in `state`), calibration holds in aggregate not per answer. TypeSafe explicitly says it is not a replacement for the LLM behind Claude Code, Codex, Cursor, or Muse Code.

**Muse Code** is Meta's terminal coding agent (beta 2026-08-05, Muse Spark 1.2). Its pitch is multi-agent: parallel workers plus background reviewers. It has no public hook or plugin API I could find, which is why the Muse + Jev work is skill-only (see next section).

## 2. The Jev + Muse orchestration you likely saw

`Bodila51/muse-jev-playbook` ("Jev decision layer for Muse"). Shape:

```
user request -> agent wakes -> build compact state -> one Jev call
  -> policy on confidence -> action -> log -> proceed or escalate
```

- One parallel question pack per expensive fork: `intent` (choice over chat/lookup/research/browser/coding/write/account), `reuse_cache` (noul), `needs_subagent` (noul), `stop_retry` (noul), `complexity` (score trivial/normal/heavy).
- Confidence policy: >= 0.80 act, 0.50 to 0.79 surface as a recommendation, < 0.50 escalate to human. Per-question floors: choice 0.55, reuse 0.65, subagent 0.75, stop_retry 0.55.
- Actions: `reuse_cache`, `stop_retry`, `run_deterministic`, `chat_only`, `research_capped`, `allow_subagent`, `ask_human`, `proceed_full`.
- Hard rules: irreversible actions always need a human regardless of confidence, kill switch (`enabled: false` or "no jev" in the prompt), redact secrets from state, fail open on Jev outage and log `jev_used: false`.
- Rollout: shadow mode first (log advice, act normally), promote a question to active only when its >= 0.80 band is right 9 of 10 times in the log.
- Two tracks: Track A is a Python reference router (`src/router.py`, `decide_action()` is a pure function over thresholds) run by hand. Track B is a Muse skill file (`skill/jev-decision-layer.SKILL.md`) with pre-connected credentials.

The repo's own words on its limit: "This skill is a policy, not a hook: the agent must wake and call Jev; nothing here reduces wake-up cost... An agent that ignores the skill ignores the gate." That is the Muse-specific weakness, and it is exactly what Claude Code fixes.

## 3. Why Claude Code is a better host than Muse

Claude Code has 33 hook events with real enforcement. The Muse playbook can only advise; a Claude Code hook can block, rewrite, or annotate. The relevant surfaces (verified against the current hooks reference, Claude Code 2.1.280):

| Hook | Input you can put in `state` | What Jev's answer can drive |
|---|---|---|
| `UserPromptSubmit` | `user_input` | `additionalContext` (inject routing advice, skill suggestion), `permissionDecision` deny. 30 s timeout. |
| `PreToolUse` (matcher `Bash`, `Edit|Write`, `mcp__.*`) | `tool_name`, `tool_input`, `cwd`, `permission_mode` | `permissionDecision: allow/ask/deny` + reason, `updatedInput` to rewrite the call. 600 s timeout. |
| `SubagentStart` (matcher on agent type) | `agent_type`, `agent_input` | `permissionDecision` deny if the agent is a bad fit; `systemMessage`. |
| `PostToolUse` | `tool_result` | `updatedResult` (prune noisy Bash output before Claude reads it). |
| `Stop` / `SubagentStop` | `last_assistant_message` | `continue: true` + reason (verify the turn actually did the work before letting it stop). |
| `PreCompact` | `triggered_by` | side effects only (score what to keep). |
| `PreModelSwitch` | `to_model` | allow/deny a model switch. |

Handler types: `command` (JSON on stdin), `http`, `mcp_tool`, `prompt`, `agent`. Exit 2 blocks on the blocking events; JSON `permissionDecision` is the clean path.

Placement rule from the Jev docs and from every working integration: Jev goes on the cheapest, highest-frequency fork, before the expensive thing, and never replaces the model that writes code.

## 4. What already exists for Claude + Jev (don't rebuild these blindly)

| Repo | Surface | What it does | Notes |
|---|---|---|---|
| `shiftynick/jev-axi` | `PreToolUse` | Local fast path for read-only/test/build commands; everything else goes to Jev with credentials redacted plus contents of any script the command runs. Five nouls: `destructive`, `exfiltration`, `remote_code`, `weakens_security`, `outside_project`. Allow / ask / deny. Audit log in `~/.config/jev-axi/stats/safety.jsonl`. | Best-designed safety gate. Fails closed on 403 by default (`--on-error`). ~0.5 s per remote call. `jev-axi setup safety --project` writes `.claude/settings.json`. |
| `onlyjq04/jev-agent-hooks` | `UserPromptSubmit` + `SubagentStart` | Two-pass skill suggestion (choice over roster, then over top 3 with SKILL.md excerpts, inject if > 0.7). Subagent gate: fit noul + model-tier choice, deny below 0.2 fit. Shadow/enforce/off env vars. | 2 to 3 s per turn for skill suggestion (slow). Denial messages in Chinese. Fail open. Ships `agents/mech.md, bulk.md, deep.md, oracle.md` tiers. |
| `shitianfang/jev-use` | MCP tools + `PreToolUse` + skill | Hands "steps needing no text output" to Jev; typed `escalate: true` back to the LLM when unsure. Backends: TypeSafe, OpenRouter, Vercel, mock. `src/redact.ts`, `src/dispatch.ts` (what never reaches Jev). | Most reusable as a library (`npm i jev-use`, zero deps on the judgment path). p50 ~230 ms, ~$0.02/1k. |
| `gargpratyush/jev-router` | Loopback proxy via `ANTHROPIC_BASE_URL` | One Jev call per fresh user turn picks a tier (Haiku/Sonnet/Opus/Fable); tool-loop continuations stay on the chosen model; no downgrade at low confidence or on large conversations (cache). | Proxy forwards auth headers untouched. Works but a proxy is a bigger trust surface than a hook. |
| `aaronshaf/opencode-jev-orchestrator` | OpenCode plugin | Parent stays on a cheap sticky model for warm cache; Jev flags hard/easy/unsure; on hard, parent calls a `jev_escalate` tool that spawns a strong child with near-full context and merges via the tool return. | OpenCode-specific, but the "escalate via tool call, never swap the parent" pattern ports to Claude Code subagents. |
| `tamaratran/jev-pruner`, `fast-jev-compaction` | `PostToolUse`, `PreCompact` | Trim Bash output; score what survives compaction. | Small, cheap wins. |
| `typesafe-ai/skills` | Skill only | Official. `claude plugin marketplace add typesafe-ai/skills && claude plugin install typesafe@typesafe-ai`, then `/typesafe:typesafe-ai`. Teaches Claude to write correct Jev calls. | Install this regardless. |

Full list: `yibie/awesome-jev` (300+ entries).

## 5. Recommended shape for "Claude + Jev"

Port the playbook's policy, replace its advisory skill with enforced hooks, and keep the shadow-first rollout. Concretely, one Claude Code plugin in TypeScript:

```
jev-claude/
  .claude-plugin/plugin.json
  hooks/hooks.json              # registers the four hooks below
  src/jev.ts                    # thin client over @typesafe-ai/sdk, timeout 800 ms, fail open
  src/redact.ts                 # strip keys/tokens/connection strings before state leaves the machine
  src/policy.ts                 # pure function: answers + thresholds -> action (port of decide_action)
  src/hooks/prompt-triage.ts    # UserPromptSubmit -> additionalContext (intent, complexity, suggested skill/agent)
  src/hooks/tool-gate.ts        # PreToolUse Bash|Edit|Write -> allow/ask/deny (jev-axi's five hazards)
  src/hooks/subagent-gate.ts    # SubagentStart -> fit + tier; deny bad fits
  src/hooks/stop-verify.ts      # Stop -> "did the turn do what the prompt asked?" noul, continue if not
  config.yaml                   # mode shadow|active, thresholds, kill switch
  logs/decisions.jsonl          # the product: every decision, confidence, outcome
```

Design decisions worth fixing up front:

1. **Hooks, not a proxy.** `jev-router`'s proxy is the only way to change the *main* model per turn, but it sits on the auth path. Everything else (gating, context injection, subagent tier, pruning, stop-verify) is a hook. Start with hooks; model tiering happens at the subagent level (`SubagentStart` deny + agent files with fixed `model:`), which is also where the sticky-parent cache argument from opencode-jev-orchestrator lands.
2. **Local fast path first, Jev second.** jev-axi's pattern: decide read-only commands, project tests/builds, and in-project edits locally with no API call. Jev only sees the residue. This keeps p50 near zero for most tool calls.
3. **Fail open everywhere except `deny` on `remote_code`/`destructive` where the local rules already fire.** A classifier outage must not block the user. Log `jev_used: false`.
4. **Redact before send.** Both jev-axi and jev-use ship a redactor. Reuse jev-use's `src/redact.ts` or copy its regex set.
5. **Shadow mode is the default.** Log the decision, act normally, promote per question after 20 to 50 decisions at >= 90% accuracy in the >= 0.80 band. This is the playbook's best idea and it costs nothing.
6. **Keep `UserPromptSubmit` under ~500 ms.** One Jev call, no two-pass roster search like jev-agent-hooks (that is the 2 to 3 s turn tax). Pass the skill roster as `choice` criteria in the same call as intent and complexity.
7. **Irreversible actions always `ask`.** Never let a high Jev confidence auto-approve a push, delete, publish, or permission change.

Question pack for the triage hook (one call, all parallel):

```ts
{
  intent:      Choice("What kind of work does this request mainly need?", {chat, lookup, research, browser, coding, write, account}),
  complexity:  Score("How much agent effort is justified?", ["trivial", "normal", "heavy"]),
  skill:       Choice("Which installed skill best fits?", {...roster from ~/.claude/skills and plugins...}),
  needs_agent: Noul("Does this clearly need a subagent beyond one turn?"),
  irreversible: Noul("Does this request ask for a send, publish, pay, delete, or permission change?")
}
```

Question pack for the tool gate (jev-axi's, proven): `destructive`, `exfiltration`, `remote_code`, `weakens_security`, `outside_project`, each a noul over `{command, cwd, script_contents}`.

## 6. Caveats to carry into the build

- Every speed and cost number is vendor-reported or from one-week-old community benches. Measure your own p50 in the decision log before trusting a threshold.
- Jev has no world knowledge. A question like "is this command safe" only works if the state contains the command *and* the context (cwd, project root, what the script does). jev-axi reads the script body for this reason.
- `UserPromptSubmit` has a 30 s hard timeout and runs on every prompt. Budget for it.
- Preserved thinking on Claude Fable 5.1: hooks that rewrite history would break it, but none of the hooks above edit the transcript, so this is fine. `updatedInput` on `PreToolUse` and `additionalContext` are append-safe.
- If you later want the *main* model to change per turn, that needs the proxy pattern or `PreModelSwitch`, and per-turn model changes invalidate the prompt cache. jev-router's "no downgrade on large conversations" rule exists for that reason.

## Sources

- TypeSafe docs: https://docs.typesafe.ai/introduction/quickstart, https://docs.typesafe.ai/introduction/coding-agents, https://docs.typesafe.ai/llms-full.txt
- TS SDK on OpenRouter: https://openrouter.ai/docs/guides/community/typesafe-sdk
- LangChain harness post: https://www.langchain.com/blog/building-a-harness-with-jev
- Eigent deep dive (limits, vendor-benchmark caveat): https://www.eigent.ai/blog/typesafe-ai-jev-system-one-models
- Cobus Greyling: https://cobusgreyling.substack.com/p/jev-by-typesafe-ai-611
- Muse + Jev playbook: https://github.com/Bodila51/muse-jev-playbook
- Muse Code: https://dev.meta.ai/products/muse-code/
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Integrations: https://github.com/shiftynick/jev-axi, https://github.com/onlyjq04/jev-agent-hooks, https://github.com/shitianfang/jev-use, https://github.com/gargpratyush/jev-router, https://github.com/aaronshaf/opencode-jev-orchestrator, https://github.com/typesafe-ai/skills, https://github.com/yibie/awesome-jev
