# Explorer 4: attacking the premise "adding Jev to Claude Code is worth it"

The premise mostly fails. Paul already runs Claude Code in `auto` mode on a Claude Max subscription (`~/.claude/settings.json`: `defaultMode: auto`, model `claude-fable-5-1[1m]`; `~/.claude.json`: `claude_max`). A built-in Anthropic classifier therefore already covers most of what the four Jev hooks would do. Only one of the four hooks survives, and only in a narrow form.

The prior pass also got facts wrong, and two change the design:
- **`SubagentStart` can't block and never sees the task prompt.** Docs: "SubagentStart hooks can't block subagent creation". Input is `agent_id` and `agent_type` only. jev-agent-hooks actually gates subagents on `PreToolUse` with matcher `Agent`.
- **Field names:** `UserPromptSubmit` blocks with `decision: "block"`, not `permissionDecision`. `PostToolUse` rewrites output with `updatedToolOutput`, not `updatedResult`. `Stop` continues the turn with `decision: "block"` or `additionalContext`, not `continue: true`.

## Alternatives found

**1. UserPromptSubmit triage**
- Built-in: skills already get picked by the main model from their descriptions, subagents from theirs. CLAUDE.md can hold routing rules.
- A `prompt` hook can't do this job. Its only output is `{ok, reason, impossible}`. On `UserPromptSubmit`, `ok:false` ends the turn, and there is no way to inject context (confirmed in the 2.1.280 binary: a successful prompt hook returns empty content).
- The builder's own data is weak. jev-agent-hooks' offline replay: the three yes/no "does this turn want an action" questions "barely separate anything" (scores overlapped 0.44 to 0.92). At a 0.7 fit threshold, a skill was suggested on 3 of 16 turns where the agent had loaded none. The "correct" labels were whatever the agent itself loaded, so not ground truth.
- Irreversibility is already covered at action time. Auto mode reads boundaries stated in conversation ("don't push") as block signals.

**2. PreToolUse tool gate**
- Auto mode (permission-modes.md): a Sonnet 5 classifier reviews every action that isn't a read or an in-project edit. Its default block list maps almost one to one onto jev-axi's five hazards: `remote_code` <-> `curl | bash`; `exfiltration` <-> "Sending sensitive data to external endpoints"; `destructive` <-> "Irreversibly destroying files" and "Mass deletion"; `weakens_security` <-> "Granting IAM or repo permissions"; `outside_project` <-> trust limited to the working directory, prompt on first read outside it, protected paths. It strips tool results from what the classifier sees, so injected text can't steer it. It also reviews subagent spawns, subagent actions and subagent reports.
- Managed Agents also ships a server-side check: `permission_policy: {type: "auto"}` with three outcomes (runs, denied, pauses). The Claude Code server-side review applies on Enterprise, API accounts, Bedrock, Vertex and Foundry. On other plans, Claude Code sends the classifier requests itself.
- Permission rules: jev-axi's local fast path is not an approval. jev-axi "never auto-approves": the fast path only decides what never goes to Jev; approval still runs through Claude Code's normal permission flow. So 100% of it needs zero code. Claude Code's built-in read-only list already covers `ls`, `cat`, `grep`, `find`, the read forms of `git`. The rest can be allow rules, e.g. `Bash(npm test)`. Command substitution and redirection already trigger prompts. Protected paths cover `.git`, `.bashrc`/`.zshrc`, `.gitconfig`. Limit: rules match command text, so `/bin/rm` gets past `Bash(rm *)`. The sandbox is the real boundary.
- A Haiku `prompt` hook is weaker than both: yes/no only, no "ask", no probability; `ok:false` ends the whole turn unless `continueOnBlock: true`; sees only the hook JSON, no transcript.

**3. Subagent fit gate (moves to `PreToolUse` matcher `Agent`)**
- Built-in: `model:` and `effort:` in agent frontmatter; `Agent(model:opus)` ask or deny rules; `CLAUDE_CODE_SUBAGENT_MODEL`; auto mode's review of the delegated task at spawn time.
- The rule layer in jev-agent-hooks needs no Jev (`subagent-model-gate.mjs` is plain code).
- Evidence for the Jev tier question is thin: 20 historical dispatches. 9 would have been denied: 3 were a stale agent shell, 2 clearly right, 3 arguable. The fit question never fired.
- `prompt` hooks aren't supported on `SubagentStart`.

**4. Stop verify**
- Built-in: `/goal` is a session-scoped `prompt` Stop hook. Runs Haiku by default and sends the transcript, truncated to 50% of the evaluator's context (about 100k tokens on Haiku). The quoting-evidence system prompt is in the binary.
- Jev can't match this. Its `state` is capped at 32k tokens, so it could only judge the final message's claims.
- A false "continue" is the real cost. It triggers a full extra Fable 5.1 turn.

## Cost and latency per call

Assumptions: hook payload ~500 to 900 input tokens; Haiku reply 30 to 60 output tokens (`reason` required); Haiku 4.5 needs a 4,096-token prefix before it caches, so hook calls are uncached.

| Option | Latency | $ per call | Notes |
|---|---|---|---|
| Permission rule / built-in read-only list | ~0 | 0 | Deterministic; not a security boundary |
| Auto mode classifier (Sonnet 5) | not measured | $0 extra on Max (billed only on Enterprise/API) | Already on for Paul; sees transcript, not tool results |
| Haiku `prompt` hook, PreToolUse | ~0.7 to 1.5 s (jev-use measured constrained Haiku p50 691 ms, p95 1.2 s) | ~$0.0007 to $0.0012; $0 on Max | Yes/no only |
| Haiku `prompt` hook, Stop | several seconds on long sessions | up to ~$0.10 on API (100k tokens); $0 on Max | Reads the transcript |
| Jev (vendor + community) | p50 223 to 252 ms via Vercel from Linux; jev-axi ~0.5 s; jev-use hook 0.71 s incl ~0.35 s Node startup | ~$0.00002 to $0.00004 | Needs a TypeSafe key and real dollars |
| Jev from this Mac (probe) | unauthenticated POST rejected in 0.21 to 0.78 s (median ~0.69 s); invalid key 1.3 s; Anthropic API same probe 0.13 to 0.15 s | n/a | Rejection path only; real p50 here probably 0.4 to 0.9 s |

Per 1,000 gated calls: Haiku about $1, Jev about $0.03, rules $0. On Max the Haiku and classifier costs aren't dollars, so cost stops being a factor and the question is latency, accuracy and trust.

Latency budget: one Jev call per prompt (~0.3 to 0.9 s) is negligible next to a Fable turn. jev-agent-hooks' two-pass design (2 to 3 s) is not; the fix is one call, but that doesn't rescue the value. In auto mode a Jev `PreToolUse` gate runs before the classifier and adds to its time. Its "ask" also forces a prompt that auto mode would not have shown. All of jev-use's gate errors were over-refusals (80.9% agreement), so real interruptions.

## Cache and history risks

- `additionalContext` is cache-safe. Appended alongside the prompt; docs say plugin hooks never invalidate the cache. Injected text is saved in the transcript and replayed on resume. Docs warn imperative phrasing can trip prompt-injection defenses.
- A per-turn model change (jev-router) re-reads the whole conversation uncached. Caches are per model. jev-router's guard only blocks downgrades once history passes ~20k tokens, so in real sessions it almost only upgrades, and every upgrade rebuilds the cache on the pricier model. That erases most of the savings.
- Effort is the tiering lever that keeps the cache. On Fable 5.1 and Opus 5.5, changing effort keeps the cache.
- Preserved thinking on Fable 5.1 is safe with every design here. None of the hooks edit history. `updatedToolOutput` replaces a result before it enters the conversation. jev-router rewrites `model`, `thinking`, `effort` in the request but never the messages.

## Trust and data handling

- Anthropic already sees every command, path and diff, because the model wrote them. A `prompt` hook or auto mode adds no new party. Retention for a consumer plan is 30 days, or 5 years if the training setting is on.
- Jev adds a new party. Via OpenRouter or Vercel it adds two.
- TypeSafe's commitments: MCA (updated 2026-09-19, four days after launch) promises not to train on Input without consent; gets a perpetual license to Customer Data for "Telemetry" and abuse monitoring, may use Telemetry "without restriction"; retention "as long as necessary"; liability capped at the greater of 12 months' fees or $50. DPA (2026-04-24) gives no fixed retention period. ZDR is enterprise-only.
- Jev can be steered by what it reads. TypeSafe's own docs: jev-1.13 "does not treat [state] as hostile by default"; adversarial content "can move the answer". jev-axi sends script contents, which an attacker can write. The auto mode classifier strips tool results for exactly this reason.
- TypeSafe's API rejected two exfiltration test cases with a 403, and jev-axi blocks on a 403 by default.

## Where Jev wins on the evidence

- Rewriting tool output in `PostToolUse` (pruning Bash output). A `prompt` hook can't return `updatedToolOutput`. Jev can score many line IDs in one call (docs cookbook does 218 in one request). Caveat: jev-use's keep-or-drop test on transcript messages scored 56.3%, below the 68.7% always-guess-the-majority baseline.
- Many questions over one state: 12 questions 224 ms batched vs 2,662 ms separate.
- Probabilities you can threshold, which makes shadow-mode promotion possible. A `prompt` hook only returns yes or no.
- Portability to Codex, pi and Muse, where no auto mode exists.
- High-frequency workloads billed per API call: vs constrained Haiku, Jev is 16x cheaper and ~3x faster.
- The pong bench (86 Jev decisions vs 6 Haiku in 20 s) is not apples to apples, and jev-use's own RESULTS.md says so: Haiku ran unconstrained and wrote ~315 output tokens per answer; 69 of the 86 Jev decisions were flagged `unsure` but played anyway; Jev never chose `stay` (0 of 13 hold states). In the fair rerun, Jev p50 225 ms vs 691 ms constrained Haiku, and decision quality "a wash". On the 454-judgment agreement set, Haiku matched the reference 35/45 and Jev 33/45.

## Verdict per hook

| Hook | Verdict | Evidence |
|---|---|---|
| UserPromptSubmit triage | **Drop.** At most, log in shadow mode. | A `prompt` hook can't inject context; the main Fable 5.1 model already reads the prompt; the builder's data shows the questions barely separate. |
| PreToolUse tool gate | **Replace with built-ins:** auto mode (already on) plus deny/ask rules plus the sandbox. Keep jev-axi only in sessions outside auto mode (Manual, `dontAsk`, Codex). | Hazards duplicate auto mode's block list; each non-routine call 0.3 to 0.9 s slower; over-refusals become prompts; data goes to a third party; adversarial content can steer it. |
| Subagent fit gate | **Replace:** deterministic `PreToolUse` `Agent` rule gate plus frontmatter `model`/`effort` plus `Agent(model:...)` rules. Jev tier choice only in shadow mode. | `SubagentStart` can't block; only 20 dispatches of evidence; the fit question never fired. |
| Stop verify | **Replace with `/goal`** when a session needs it. Drop the always-on version. | `/goal` reads the transcript; Jev is capped at 32k of state; a false "continue" costs a full Fable turn. |
| (new) PostToolUse output pruning | **Only place Jev clearly wins.** Build in shadow mode first. | No built-in model option; evidence thin and the keep-or-drop test scored below baseline. |

## Files read
- The v1 research doc; /tmp/jev-research/docs/{hooks,permissions,permission-modes,prompt-caching,sub-agents,skills,goal,costs,model-config,data-usage}.md; /tmp/jev-research/prompthook.txt (prompt-hook evaluator extracted from the Claude Code 2.1.280 binary); jev-use bench/RESULTS.md; jev-axi src/safety.ts, README.md; jev-agent-hooks README.md, config/claude-settings.snippet.json; jev-router src/{policy,proxy,config}.mjs; llms-full.txt; /tmp/jev-research/ts/*.txt (TypeSafe privacy policy, terms, DPA, MCA); ~/.claude/settings.json, ~/.claude.json (read-only).

## Open questions
- Real authenticated Jev p50 from this Mac. Probes only hit rejection paths.
- How fast the auto mode classifier is on Max. Undocumented.
- Whether the evaluator caches the transcript for Stop `prompt` hooks.
- `autoMode.environment` in `~/.claude/settings.json` describes only cargo-diet. It is global, so the classifier gets cargo-diet context in every other repo. Worth checking separately.
