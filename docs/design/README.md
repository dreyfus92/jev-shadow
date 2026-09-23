# jev-shadow v0.1 design

Synthesized from three arena candidates. This file is candidate 1 with the grafts recorded under "Synthesis decision". The rejected candidates are kept alongside for the record.

## Problem

Measure whether Jev's typed hazard verdicts agree with Claude Code's auto-mode classifier on real coding actions, at zero added latency. Later, gate tool calls for hosts that have no classifier. No independent calibration data for Jev exists, so the log is the product.

Four facts from grounding make the shape non-obvious.

- **Async alone does not make shadow harmless.** An `"async": true` hook's `permissionDecision` is ignored. Its `additionalContext` and `systemMessage` are still delivered to Claude on the next turn (hooks.md, "How async hooks execute"). Shadow can only be inert if the shadow process cannot print.
- **The three events for one tool call arrive in three processes, possibly at once.** The async PreToolUse observer is often still waiting on Jev when PostToolUse fires. Any design that updates one joined record needs a lock.
- **Hook topology is static.** hooks.json fixes async or sync per entry at install time. The user's mode lives in a config file and changes at runtime, so mode cannot choose the hook. It can only choose which registered hook acts.
- **The known leaks are ordering and splitting bugs, not missing regexes.** jev-axi truncates before redacting and does not split on `&`. Both are one-line fixes that the next contributor can silently undo. The design has to make them unrepresentable.

Constraints carried in: jev-axi's question pack verbatim (keeps its 44 labeled cases valid), `jev-1.13.0` pinned, Node 20, zero runtime deps, CLI hooks fail open on timeout, and plugins cannot ship permission rules.

## Usage (caller's view)

### README quickstart

```sh
# 1. install. the plugin installs disabled (defaultEnabled: false)
claude plugin marketplace add dreyfus92/jev-shadow
claude plugin install jev-shadow@jev-shadow
#    prompted for jev_api_key (sensitive, stored in the Keychain). leave empty to use the mock backend

# 2. enable it only in the repo you want measured. writes .claude/settings.local.json (not committed)
cd ~/Documents/bombshell/clack
claude plugin enable jev-shadow@jev-shadow --scope local

# 3. turn it on. no config file means mode "off": nothing leaves the machine until this runs
jev-shadow mode shadow          # writes ~/.config/jev-shadow/config.json

# 4. work normally in auto mode. later, inside Claude Code
/jev-shadow:report

# kill switch, takes effect on the next tool call in every running session
jev-shadow mode off
```

Step 2 writes this to the repo's `.claude/settings.local.json`. You can also add it by hand:

```json
{ "enabledPlugins": { "jev-shadow@jev-shadow": true } }
```

`~/.config/jev-shadow/config.json`, user-owned and never read from a repo:

```json
{
  "mode": "shadow",
  "backend": { "kind": "typesafe" },
  "policy": { "thresholds": { "deny": 0.8, "ask": 0.45, "askRisk": 1.5 }, "onError": "allow" },
  "budgets": { "gate": 3000, "observe": 8000 }
}
```

Modes, as the README states them:

- `off` sends nothing and logs nothing.
- `shadow` asks Jev in the background, logs the verdict next to the classifier's decision, and changes nothing. Zero added latency on the observed path.
- `enforce` runs a synchronous gate that prints `ask` or `deny`, or nothing for allow. In an auto-mode session it behaves as `shadow`, because the classifier already gates and a Jev `ask` would force prompts auto mode skipped. `onError` (default `allow`) decides what a failed Jev call becomes. In `dontAsk` mode and `-p` without a permission prompt tool, `ask` becomes a hard deny. A CLI hook timeout always fails open, whatever `onError` says.

### Call site 1: the hook bin

`bin/jev-shadow`, run by hooks.json in exec form (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/jev-shadow", "hook", "observe", "--data", "${CLAUDE_PLUGIN_DATA}"]`):

```js
#!/usr/bin/env node
import { main, nodeIo } from "../dist/cli.js";
import { claude } from "../dist/hosts/claude.js";

process.exitCode = await main(process.argv.slice(2), nodeIo(), claude);
```

The host adapter is chosen here and nowhere else. A Codex bin passes `codex` instead.

### Call site 2: a test (no key, no network)

```ts
test("enforce: a real PreToolUse for `rm -rf ~` is denied through the mock backend and logged once", async () => {
  const io = fakeIo({ stdin: fixture("claude/pre-tool-use.bash.rm-home.json"), config: { mode: "enforce" }, jev: hazards });
  assert.equal(await main(["hook", "gate", "--data", "/data"], io, claude), 0);
  assert.equal(JSON.parse(io.stdoutText()).hookSpecificOutput.permissionDecision, "deny");
  const [record, ...rest] = io.logRecords();
  assert.equal(rest.length, 0);
  assert.equal(record?.kind === "attempt" && record.posture, "gate");
});

for (const { name, input, secret } of leakCorpus) {
  test(`no leak end to end: ${name}`, async () => {
    const io = fakeIo({ stdin: preBash(input), config: { mode: "shadow" }, jev: hazards });
    await main(["hook", "observe", "--data", "/data"], io, claude);
    assert.ok(!leaks(io.requests().join("\n"), secret), "request body to Jev");
    assert.ok(!leaks(io.logText(), secret), "log file");
  });
}
```

The mock backend is a `fetch` built from a fixtures table that returns raw wire JSON. The response parser, the deadline, and the exact request bytes are exercised in every test. Full sketches are in `test/hook.test.ts`, `test/rules.test.ts`, `test/report.test.ts` and `test/packaging.test.ts`.

### Call site 3: the report

`/jev-shadow:report` (a plugin command that runs `jev-shadow report`), or in code `render(summarize(join(decode(text).records), malformed))`. The numbers below are illustrative:

```
the auto-mode classifier is a reference, not ground truth. every rate is shown with its counts.
log ~/.claude/plugins/data/jev-shadow-jev-shadow/log.jsonl   2026-09-24 .. 2026-10-08

attempts 1,204   decided by local rules 842 (never sent)   sent to jev 362

backend typesafe   model jev-1.13.0   comparable (auto mode, labeled) 331
  hazard            jev>=0.8  denied  agree         same-category agree
  destructive              4       3  327/331 98.8%  3/4
  exfiltration             2       1  330/331 99.7%  1/2
  remote_code              3       3  331/331 100%   3/3
  weakens_security         1       0  330/331 99.7%  0/1
  outside_project          6       1  325/331 98.2%  n/a (no classifier category)
  over-refusal (any hazard >= 0.45, classifier let it run)   41/319 (12.9%)
  >= 0.8 band accuracy (classifier also denied)              5/9 (55.6%)
  jev latency, cold process incl. TLS   p50 412 ms  p95 690 ms  n=353
  tokens   in 612,433  out 21,774  (1,735 / 62 per call)
  errors   deadline 7, http 429 2

rule-table misses (local routine, classifier denied): 0
unmapped classifier labels: [Production Deploy] x2
unlabeled 38   orphan labels 4   malformed lines 0
hook wall time   observe p50 431 ms   gate n=0
```

## Shape

### Module map

Ten source files. Tracing a hook takes three: `cli.ts` to `core.ts` to one of `rules.ts`, `egress.ts` or `jev.ts`.

| File | Owns | Hides |
|---|---|---|
| `src/core.ts` | Domain: `HookEvent`, `Action`, `Mode`, `Posture`, `Decision`. Pure `actingPosture` and `decide`, and `assess` (the one async step, with effects injected). The `HostAdapter` contract. | Mode and posture interplay, threshold policy, which posture acts |
| `src/rules.ts` | Shell tokenizer, command rule table, sensitive paths, pure `triage` | Shell grammar, flag clusters, the jev-axi gap fixes |
| `src/egress.ts` | `Raw` and `Redacted` brands, the ordered pattern table, `redact`, `clip`, `toJevState`, `excerpt`, `fingerprint` | Redact-then-clip ordering, field budgets, what Jev and the log may see |
| `src/jev.ts` | Question pack, pinned model, endpoint table, `Deadline`, `Secret`, `ask`, mock `fetch` | Wire JSON, HTTP status mapping, abort handling, response validation |
| `src/log.ts` | `LogRecord` union, record constructors, `encode` and `decode` | JSONL format, line bound, tolerant parsing |
| `src/report.ts` | `join`, `summarize`, `render`, label-to-hazard map | The join on `tool_use_id`, dedupe, rate math |
| `src/config.ts` | `Config`, `parseConfig`, `withMode`, budget ceilings | Defaults, clamping, env downgrade-only rule |
| `src/hosts/claude.ts` | Claude Code stdin parse and stdout render | Every Claude wire field name |
| `src/hosts/codex.ts` | v0.2 stub | Codex's deny-only output |
| `src/cli.ts` | Argv, `Io`, `runGate`, `runObserver`, `runReport`, `mode` | Process, fs, clock, network |

### Data structures and the access patterns through them

**Events are a union parsed at the boundary.** `HookEvent = attempt | denied | ran`, each carrying an `EventContext` with branded `SessionId`, `ToolUseId` and `AbsPath`. `PermissionMode` includes `"unknown"` because not every event carries the field, so absence is a value and not an optional field. `agentId: string | null` is the one nullable field, since it is genuinely absent on the main thread. Adapters return `unsupported` for any tool they don't model, so a matcher slip is harmless.

**Mode and posture are two types, and one function relates them.** `Mode` (`off | shadow | enforce`) is the user's switch. `Posture` (`observe | gate`) is how the process was started, fixed by hooks.json argv. `actingPosture(mode, event)` returns the single posture that acts on an event. Both hook processes call it with the same inputs, so exactly one acts, by construction and not by coordination. The kill switch is `mode: "off"`. A separate `killed` boolean would allow the meaningless state `enforce + killed` (per type-system-discipline).

**Shadow is inert by type.** `ObserverIo = Omit<Io, "stdout">`. `runObserver` receives no way to print, so it cannot inject `additionalContext` either. The gate is the only function holding `stdout`. The exit type is `0 | 1`, so the one blocking exit code, 2, cannot be written. A crash exits 1, which is non-blocking.

**Shadow and enforce compute the same decision.** `decide(assessment, policy)` is pure and runs in both modes. The attempt record stores `effect` and `posture`, so a shadow log says exactly what enforce would have done. That is the property the Muse playbook claimed and did not have: its shadow and active paths had identical *effects*. Here they have identical *computation* and differ only in whether `render` is reachable.

**Redact before truncate, by type** (per encode-lessons-in-structure). `Raw` is made only by `fromHost` in adapters. `Redacted` is made only by `redact`. `clip` takes and returns `Redacted`. Since `raw.slice()` returns plain `string`, both `clip(raw, n)` and `redact(raw.slice(0, n))` are compile errors. `test/egress.types.ts` pins four such lines with `@ts-expect-error`, and the sketch passes `tsc` strict (TS 6.0.3), which proves each line really fails. The pattern table is ordered data with the ordering rationale inline: PEM first, unterminated PEM redacts to the end of the text, and no value class crosses `; & |`, so `--password=x;rm -rf ~` keeps `;rm -rf ~` visible to Jev. The table was run against the 26-entry leak corpus in a scratch harness. Every entry passes, including the checks that verdict-relevant text survives (`mkdir -pv`, `--password-stdin -u me`, `$TOKEN`). The corpus's token-straddle case leaks under truncate-then-redact and does not leak under redact-then-clip. That reproduces the jev-axi bug class on a fixture.

**Rules run on raw text and emit no text.** A redaction pattern that swallowed an operator would make a dangerous command look routine, so `triage` reads `Raw`. It returns only a `RuleId` or a `Miss`. The tokenizer's contract is that every byte lands in exactly one segment or the result is `opaque`, and opaque is never routine. A parser gap therefore sends more to Jev. It can never pass a command through unseen. Flags are data (`short` matches inside clusters, so `-Ei` hits `i`; `word` is an exact match, so `-fprintf` is caught; `long` also matches `--x=v`). Rules index as `Map<argv0, CommandRule[]>`, so each segment costs one map hit. Beyond the brief's list, the sketch closes `git -c core.pager=...` (`subFirst`), `sed 's/a/b/w file'` and GNU `e` (`sed_no_write_exec`), and `rm -rf $DIR` (non-literal args).

**The log is per-actor append, joined at read** (per separate-before-serializing-shared-state). Each event appends its own line in one `appendFileSync` on O_APPEND. Every line is bounded far below PIPE_BUF because the only free text is a 200-char redacted excerpt. No process reads or rewrites another's record, so there is no lock. `report.join` groups by `toolUseId` in one pass over the log. Arrival order does not matter. Duplicates keep the earliest `at`. PostToolUseFailure counts as `ran`, because it only fires after a call passes permission. Only `permission_mode: "auto"` attempts are compared with the classifier. Routine attempts are logged too, so the report can show rule-table misses (local routine, classifier denied). That turns the same join into a check on the rules.

**One deadline per process, measured from process start.** `Deadline.fromProcessStart(performance.timeOrigin, budget)` means Node startup, config, and stdin all count. `ask` requires a `Deadline`, so an unbounded call cannot be written. The signal covers the body read as well as the headers. There are no retries. The gate budget ceiling (3,500 ms) and the hooks.json gate timeout (5 s) are tied by `test/packaging.test.ts`, which reads hooks.json. The two numbers cannot drift apart silently. That test also asserts every matcher is anchored, because an unanchored `Write` matches `TodoWrite`.

**No SDK.** `@typesafe-ai/sdk` has no total budget. It reads ambient env: `TYPESAFE_BASE_URL` can redirect the body, `TYPESAFE_LOG_LEVEL=debug` logs bodies unredacted, and the default model is `jev-latest`. It also does not validate responses, so we would parse them anyway. One POST with a fixed pack is a short `fetch` call. Endpoints are constants and never read from env or from a repo.

**Noul certainty is the two-sided band** (`yes >= 0.8`, `no <= 0.2`, else `unsure`), from TypeSafe's docs. The policy and the report already threshold at 0.8, so a band keeps "how sure" and "which way" in one value. `2*|p-0.5|` would add a second scale nobody reads. The report's band accuracy is the calibration check on this choice.

**Config is user-owned and downgrade-only from env.** It is read from `~/.config/jev-shadow/config.json` on every invocation, so `mode off` is live everywhere at once. It is host-agnostic, so the v0.2 adapters share it. It is never read from a project, so a cloned repo cannot raise the mode or redirect the backend. `JEV_SHADOW_MODE` may lower the mode but never raise it. A missing or invalid file means `off`. The API key comes only from userConfig (`CLAUDE_PLUGIN_OPTION_JEV_API_KEY`) through the adapter, wrapped in `Secret`, whose `toJSON` prints `[secret]`.

### Interface depth

The whole surface a new host needs is `HostAdapter`: a parse, a render, and a key lookup. The core's own surface is `actingPosture`, `assess` and `decide`: two pure functions and one async step. Behind them sit a shell tokenizer, a rule table, ordered redaction with field budgets, deadline and error mapping, and threshold policy. No Jev or hook wire type is exported. `WirePreToolUse` and the Jev request and response live privately in `hosts/claude.ts` and `jev.ts`. `Backend` is data (url, pinned model, key, fetch), so the four backends share one code path and the mock sits below the wire parser.

### What it deliberately does not do

It never grants. Allow prints nothing, so deny and ask rules still apply, and a Jev steered by hostile script contents can only fail to add a deny. It adds no retries, rotation, daemon, or MCP server. It does not ask Jev about routine calls. It does not use the report's bands as policy. It does not write Jev output anywhere but the local log (MCA 2.3(b): evaluation only).

## Synthesis decision

Three candidates were produced in parallel on three model families (opus, fable, sonnet), scored by the coordinator and by an independent cross-judge on a different model, against the six-criterion rubric in `docs/research/design-brief.md`. Both picked candidate 1 as the base (judge: 28/30, against 21 and 11). It was the only candidate where truncating unredacted text fails to compile in both directions, the only one that passed the full 30-entry leak corpus (candidate 2 failed 2, candidate 3 failed 5), and the only one whose background observer cannot print, which matters because an async hook's `additionalContext` and `systemMessage` are delivered to Claude on the next turn (hooks.md, "How async hooks execute").

Grafted in:
- From candidate 3: `Config` is a union on `mode`, so `off` carries no backend, key, or thresholds. Reduced graft: candidate 3 also removed `onError` from the shadow variant. Rejected, because `decide` must be the same function in both postures for the shadow log to say what enforce would have done, including on a failed Jev call.
- From candidate 2: the three replayable hook event fixtures (`test/fixtures/events/`), one per phase.
- From the judge: the `other` variant of `JevState`, so an `Action` of kind `other` has a state shape.

Rejected:
- Candidate 2's POSIX `sh` mode guard before `node`. It saves the 20 to 30 ms no-op spawn in off and shadow, at the price of mode logic in two languages, a second mode file, and no Windows without Git Bash. Deferred; the sync gate exits before reading stdin when mode is not enforce, and the cost is measured in the report as gate wall time.
- Candidate 3's `Decision.unknown` variant and separate `applyFailurePolicy`. Candidate 1 already keeps a failed call visible as `basis.kind === "jev_failed"` on the record, with `effect` from `policy.onError`, and the report counts errors by kind.
- The judge's request to move `Raw` construction for scripts into the adapter. Script contents are read from disk by the shell, not parsed from a host, so there is no adapter to own them. `fromHost` stays the single minter and `readScripts` calls it; a lint may enforce that later.

Kept as candidate 1 had it, and flagged for the user: enforce yields to auto mode (observes instead of gating). The brief did not ask for it. The research did: a Jev `ask` in an auto session forces prompts the classifier would have skipped.

## Tradeoffs accepted

- We accept a synchronous no-op process per matched tool call in shadow mode (about 20 to 30 ms, measured as a `node` no-op spawn on this Mac, Node 24). In exchange, one plugin holds mode as one live config value. The gate exits before reading stdin when `mode !== "enforce"`.
- We accept cold TLS on every Jev call, because each hook is a fresh process. The reported p50 includes the handshake and is labeled "cold process". In exchange, there is no daemon to start, stop or version.
- We accept that `rules.ts` reads secrets. In exchange, redaction can never hide a shell operator from the local fast path. Its output type carries no text.
- We accept that the tokenizer over-sends (anything opaque goes to Jev). In exchange, the tokenizer has no bypass class.
- We accept that enforce in an auto-mode session only observes. In exchange, a Jev `ask` never interrupts a call the classifier would have passed silently.
- We accept report bands fixed at 0.8 and 0.45, independent of `policy.thresholds`. In exchange, tuning the policy never moves the yardstick.
- We accept that an invalid config silently means `off`, which fails open. In exchange, a typo can never turn enforce on or send data. `jev-shadow mode` writes the file canonically, which makes typos rare.
- We accept one uniform `onError`, which also covers 403 firewall rejections. In exchange, the policy is simple. The 403 is still logged as its own error kind, so the report can argue for changing this.

## Alternatives considered

**Two plugins from one repo, `jev-shadow` (async hooks only) and `jev-gate` (sync gate only).** This drops the shadow no-op spawn to zero. It loses because mode would live in `enabledPlugins` across three settings scopes, and flipping it needs `/plugin` and a reload instead of one live value. `off` would mean "disable both". Two manifests would drift. Callers, meaning users, would have to learn our topology to change a mode. The interface gets wider to save 25 ms off the critical path of a measurement tool.

**One joined record per tool call, updated in place (SQLite or read-modify-write JSONL).** The report would get simpler, since there is no join. It loses because three concurrent processes write one row, so it needs a lock or `node:sqlite` (experimental on Node 20). A crash mid-update loses the attempt. The complexity moves from a pure, testable `join` into every writer, and a lock appears where the domain says state need not be shared.

**A long-lived local daemon behind `type: "http"` hooks, holding a warm connection to Jev.** Warm TLS would cut measured latency and remove per-call node startup, and one process could batch. It loses on lifecycle. Something must start it, pick a port, restart it on plugin updates (`CLAUDE_PLUGIN_ROOT` changes each update), and kill it. An http hook failure is silently non-blocking, so a dead daemon would quietly turn enforce off. It also leaves a resident process on the user's machine that reads every tool call. v0.1 measures. If cold latency turns out to decide promotion, a daemon can come back as an `Io.fetch` swap without touching the core.

## Implementation reconciliation

- `package.json` `test` script: the sketch ran `node --test dist/test/`, which Node 20 expands as a directory and Node 21+ treats as a single file path (`Cannot find module .../dist/test`). Now `node --test dist/test/*.test.js`, shell-expanded, which both accept. The contract (`tsc -p .` then `node:test` over the compiled tests) is unchanged.
- `test/egress.test.ts`: the design says the corpus's token straddle leaks under truncate-then-redact. That holds for the `ghp_` case only. The PEM straddle does not leak under either order, because `pem` redacts an unterminated block to the end of the text (`|$`), so a block cut before its END marker is still covered. The test asserts each case's real property instead of one claim over both.

## Open questions and risks

- What exact pinned ids do Vercel and OpenRouter accept? Vercel returns unversioned `typesafe-ai/jev`, so drift is undetectable there. Should the report refuse to mix unpinned groups with pinned ones, or only flag them as sketched?
- Which rule labels can the classifier emit? `LABEL_TO_HAZARD` has two confirmed entries. Unknown labels are listed in the report, never guessed. Is that enough for v0.1?
- Does a plugin command's `` !`jev-shadow report` `` get the plugin `bin/` on PATH and `CLAUDE_PLUGIN_DATA` in its environment? If not, `discoverLog` globs `~/.claude/plugins/data/jev-shadow-*/log.jsonl`.
- Should a 403 firewall rejection deny in enforce regardless of `onError`? jev-axi's `auto` does this. Its bodies were literal attack commands.
- Is 20 to 30 ms per tool call in shadow acceptable? If not, the cheapest fix is a `sh` prefilter reading a one-word mode file, which puts mode into a second file.
- Script contents (`local_scripts_run`) can steer Jev. Since Jev can never grant, the worst case is a missed deny. Is that acceptable for enforce, or should enforce drop scripts?
- In `-p` runs, async observers are killed at teardown, so late attempts go unlabeled. The report counts them. Is that population large enough to bias agreement?
- The log grows without bound. v0.1 has no rotation. Is `jev-shadow report --since` plus manual deletion enough?
- `dist/` must be committed on release tags, because plugin installs do not build. Is a release branch acceptable, or should CI commit `dist/`?

## Next implementation step

Implement `egress.ts` (`redact`, `clip`, `toJevState`) against `test/fixtures/leaks.jsonl` and `test/egress.types.ts` first. It is the one module where a bug leaks secrets instead of adding a Jev call. Then `splitShell` against the `rules.test.ts` gap table.
