# jev-shadow v0.1, candidate 2

## Problem

Build a Claude Code plugin that runs TypeSafe Jev as a shadow-first decision layer over tool calls and can become a gate for hosts with no classifier. The shape is non-obvious for four reasons the grounding surfaced. Shadow must add zero foreground latency and must be unable to affect the session, which only an `"async": true` command hook guarantees, yet enforce needs a synchronous hook, and `hooks.json` is static: a plugin cannot flip `async` from config. Jev's SDK has no total time budget and retries by default, while every CLI hook timeout fails open, so the deadline has to be ours and sit under the hook timeout. Truncate-before-redact leaked 2,864 raw PEM characters in jev-axi, so the order has to be a compile-time fact. And three hook events for one tool call arrive as three processes, possibly overlapping, so the log cannot be a read-modify-write. The brief's hard requirements (modes, local rule table with jev-axi's gaps covered, pinned question pack, four backends with one deadline, redact-before-truncate by type, JSONL keyed by `tool_use_id`, the report, fail-open shadow with `onError` for enforce, sensitive `userConfig` key, ESM TypeScript with zero runtime deps and a thin host adapter) are treated as constraints.

## Usage (caller's view)

### README quickstart

```
# jev-shadow

Measures whether TypeSafe Jev's hazard verdicts agree with Claude Code's
auto-mode classifier on your real tool calls, without slowing anything down.
Later, a gate for hosts that have no classifier.

## Install

    claude plugin marketplace add dreyfus92/jev-shadow
    claude plugin install jev-shadow@dreyfus92     # prompts for your TypeSafe key; stored in the Keychain

The plugin installs disabled. Enable it per project, only in repos whose
commands and diffs you are willing to send to TypeSafe:

    // .claude/settings.local.json
    { "enabledPlugins": { "jev-shadow@dreyfus92": true } }

Then choose a mode. The default is off; nothing leaves the machine until you say so:

    jev-shadow mode shadow

## Read the results

    jev-shadow report

Prints, per hazard, how often "Jev >= 0.8" agreed with a classifier denial,
the over-refusal rate, the accuracy of the >= 0.8 band, latency p50/p95, and
token usage. The classifier is a reference, not ground truth.

## Modes

    off       nothing runs (one `sh` exec per tool call, no node)
    shadow    async hooks ask Jev and log; cannot affect the session by construction
    enforce   a synchronous PreToolUse hook prints allow (nothing), ask, or deny.
              For Manual mode, dontAsk, Codex, pi. Pointless under auto mode.

Enforce failure policy is `onError` in config.json (`allow` default, `ask`,
`deny`). `ask` becomes a hard deny in `dontAsk` and `-p`. A hook that hits the
host's timeout always fails open; the plugin's own deadline is shorter so
that never happens silently.

## Config

    ~/.claude/plugins/data/jev-shadow-dreyfus92/
      mode              one word: off | shadow | enforce   (jev-shadow mode <m>)
      config.json       { "backend": {"name": "typesafe"}, "policy": { "thresholds": {...}, "onError": "allow" } }
      decisions.jsonl   the log

Backends: typesafe, vercel, openrouter, mock. Without a key:

    { "backend": { "name": "mock", "fixtures": [ { "match": { "command": "rm -rf ~" }, "verdict": { "destructive": 0.97, "risk": 1.9 } } ] } }

Never put config in the repo; the plugin does not read it from there.
```

### Call site 1: the hook bin (`src/bin.ts`, `runHook`)

```ts
const parsed = host.parseEvent(JSON.parse(await io.stdin()));
if (parsed.kind === "skip") return 0;
const dataDir = host.dataDir(io.env, io.home);
const cfg = readConfig(io.fs, dataDir);
if ("kind" in cfg) { io.stderr(cfg.message); return 0; }
const event = parsed.event;
if (role === "record") { if (event.phase !== "pre") appendRecord(io.fs, paths(dataDir).log, recordOf(event)); return 0; }
if (event.phase !== "pre") return 0;

const local = triage(event.call, event.cwd, RULES);
const judged: Judged = local.kind === "routine"
  ? { local }
  : { local, jev: await backendFor(cfg, host, io).ask(buildState(event, io.fs), SAFETY_PACK, deadline(BUDGET_MS[role], io.clock)) };
const decision = decide(judged, cfg.policy);
appendRecord(io.fs, paths(dataDir).log, { event: "pre", mode, role, decision, summary: summarize(redact(callText(event.call))), ...ids(event) });
if (role === "enforce") io.stdout(host.renderDecision(decision, event.permissionMode));
return 0;
```

### Call site 2: a test (`test/hook.test.ts`)

```ts
test("ls & rm -rf ~ reaches Jev and is denied in enforce mode", async () => {
  const io = fakeIo({
    mode: "enforce",
    config: { backend: { name: "mock", fixtures: [{ match: { command: "rm -rf ~" }, verdict: { destructive: 0.97, risk: 1.9 } }] }, policy: DEFAULT_CONFIG.policy },
    stdin: fixture("events/pre-bash.json"),
  });
  assert.equal(await main(["hook", "--as", "enforce"], io), 0);
  assert.deepEqual(JSON.parse(io.stdoutText()).hookSpecificOutput.permissionDecision, "deny");
  const [rec] = io.logRecords();
  assert.equal(rec.event, "pre");
  assert.equal(rec.decision.by, "jev");
  assert.ok(!io.logText().includes("rm -rf ~") || rec.summary.length <= 200);
});

test("the mock honors the deadline", async () => {
  const io = fakeIo({ mode: "enforce", config: mockWith([{ match: {}, delayMs: 60_000 }]), stdin: fixture("events/pre-bash.json") });
  await main(["hook", "--as", "enforce"], io);
  assert.equal(io.logRecords()[0].decision.by, "error");          // onError allow -> stdout ""
  assert.equal(io.stdoutText(), "");
});
```

### Call site 3: the report (`src/bin.ts`, `runReport`)

```ts
const { records, skipped } = readRecords(io.fs, paths(dataDir).log);
io.stdout(render(summarize(join(records), cfg.policy.thresholds)));
if (skipped) io.stderr(`${skipped} torn lines skipped`);
```

## Shape

**Data structures first.** Five domain types carry everything, and each is a discriminated union where a wrong combination would otherwise be an optional field.

- `HookEvent` (`event.ts`): `phase: pre | denied | post`, each with exactly the payload that phase has. `ToolCall` has no `other` variant; tools outside the matcher never become events. `AbsPath` is branded and adapters normalize `\` before constructing one, so the Windows path note from the docs is a type, not a comment. Per **type-system-discipline**.
- `Local` (`rules.ts`): `routine` with the `RuleId` that approved it, or `evaluate` with why. The rule id in the log is how a future bypass is traced to a row.
- `Judged` (`decide.ts`): `{ local: routine }` or `{ local: evaluate; jev: JevResult }`. Asking Jev without triage, or evaluating without asking, does not compile. `decide(judged, policy) -> Decision` is the pure core; it is `decide(event, rules, verdict?)` with the sequencing moved into the input type. Per **model-the-domain**.
- `Decision`: `by: rule | jev | error`. The `jev` variant embeds the whole `Verdict` (hazards, risk, model, usage, latency) so the log record has no optional verdict.
- `LogRecord` (`log.ts`): `event: pre | denied | post` over a base with `Summary`, the only free text. `Summary` is `Redacted` capped at 200 chars, by type.

**Dominant access patterns traced.** Hook path: parse (adapter) -> `triage` (table lookup on the command word per segment) -> `buildState` -> `Backend.ask` -> `decide` -> `appendRecord` -> render (adapter). One file per step, and `bin.ts` calls them in a straight line; a reader traces any flow through `bin.ts` plus one module. Report path: `readRecords` -> `join` (group by `toolUseId`, last record per `(id, event)` wins) -> `summarize` -> `render`. No index or cache is needed later: the log is append-only and the join is a single pass.

**Load-bearing decisions.**

1. *Mode is a one-word file the shell reads before node.* `hooks/run.sh` is a three-line POSIX guard; it `exec`s node only when its registration's role matches the mode. Both PreToolUse registrations ship (async `shadow`, sync `enforce` with `timeout: 8`) and the guard picks one. `off` costs one `sh` exec per tool call and no node startup; shadow adds zero foreground latency because the only foreground process is the guard saying no. The mode file is also the kill switch, so there is no second `enabled` flag to keep in sync (single source of truth per invariant). Config is never read from the project directory, for the same reason Claude Code ignores project `pluginConfigs`: a cloned repo could redirect `backend` to a URL that receives every command.
2. *Shadow cannot act, by the host's rule.* The shadow registration is `"async": true`, so the host discards `permissionDecision`. Belt and braces: `runHook` only calls `renderDecision` when `role === "enforce"`. Requirement 1 and 8 are the `async` flag, not discipline.
3. *`Redacted` is a brand only `redact` can mint.* `truncate`, `summarize`, and every text field of `JevState` take `Redacted`. Truncating raw text is a compile error. PEM is the first pattern and masks to end-of-text when the END marker is missing. Files over 512 KB are not read at all rather than read and cut, so "refuse" never becomes "truncate". Per **encode-lessons-in-structure**: the jev-axi leak becomes a type, not a review checklist item.
4. *One deadline, no SDK.* `Backend.ask` requires a `Deadline`, and a `Deadline` is the only source of the `AbortSignal`, so an un-budgeted call has nothing to pass. One `fetch`, no retry, `AbortError` maps to `failed: timeout`. The SDK is not used because it has no total budget (10 s per attempt, 2 retries, Retry-After to 60 s), retries by default, logs bodies at `debug`, and would be the only runtime dependency for one POST that Node 20's `fetch` already does. `BUDGET_MS.enforce = 5000` under `ENFORCE_HOOK_TIMEOUT_S = 8`, and `test/packaging.test.ts` reads `hooks.json` and asserts the inequality, because the type system cannot read JSON.
5. *Rules are a table with four row kinds.* `always`, `unless` (flag set with short-cluster expansion so `-Ei` hits `i` and `-i.bak` hits `i`), `sub` (git-style subcommand map with per-subcommand flags), and `fn` for the three irregulars (rm targets, cd target, package managers). The walker is generic; jev-axi's if-chain becomes rows, and `test/fixtures/commands.json` mirrors the table row for row, including `ls & rm -rf ~`, `sed -Ei`, `sort -o`, `find -fprintf`, `git diff --output`, and `cd / && rm -rf tmp`. `splitSegments` is quote-aware and treats a single `&` as a separator after stripping fd-duplication redirects. Erring toward `evaluate` costs a Jev call; erring toward `routine` is a bypass, and the table is tuned for that asymmetry.
6. *Per-actor log lines, joined on read.* Each hook process appends one line under `PIPE_BUF` with a single O_APPEND write; `appendRecord` empties `summary` and retries if a record would exceed 4096 bytes, and throws if it still does. No process reads the log except `report`. Per **separate-before-serializing-shared-state**: the three writers publish independent facts and the merge happens at the read boundary.
7. *Noul certainty is written down once.* `certainty(p) = 2|p - 0.5|` and the two-sided band (`yes` >= 0.8, `no` <= 0.2) live in `decide.ts`; thresholds and the report's band accuracy read the same constants. Model pinned to `jev-1.13.0` in `questions.ts`; the log stores the backend's reported model so alias drift is visible where the gateway reports a version.
8. *Adapters are parse and render, nothing else.* `Host` is four functions: `parseEvent`, `renderDecision`, `dataDir`, `apiKey`. `claude-code.ts` is the only file that knows `hook_event_name`, `hookSpecificOutput`, `[Rule]` reason strings, `CLAUDE_PLUGIN_OPTION_API_KEY`, and `CLAUDE_PLUGIN_DATA`. `codex.ts` is the whole port, stubbed. Per **boundary-discipline**: wire JSON is parsed once at the edge and rendered once at the edge.

**Where validation lives.** `parseEvent` (host JSON), `readConfig` (user file, unknown keys rejected), `parseResponse` (Jev JSON, every hazard present and in range). Inside those three boundaries no function re-checks. Business logic (`triage`, `buildState`, `decide`, `join`, `summarize`) is pure; `bin.ts` is the only file that touches `Io`.

**What it deliberately does not do.** No exit code 2, ever (a hook run always exits 0 and speaks only JSON, so an accidental non-zero can never block). No project-level config. No SDK. No log rotation in v0.1. No PostToolUse output pruning, no UserPromptSubmit, no Stop.

**Interface depth.** The public surface is `main(argv, io)` for the shell and, for a library reader, `triage`, `decide`, `redact`, `join`, `summarize`. Behind `main` sit segment splitting, flag-cluster expansion, script inlining, redaction ordering, the deadline, backend selection, atomic appends, and host rendering. A caller of `decide` supplies a `Judged` and a `Policy` and gets a `Decision`; it never sees a probability threshold applied or a Jev field name. `Host` is four functions because that is the entire difference between hosts that share the stdin contract. Nothing exposes a Jev question, a hook JSON key, or a fetch option. Per **minimize-reader-load** the call hierarchy is one level deep from `bin.ts`.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept a POSIX `sh` guard (and therefore no Windows-without-Git-Bash support in v0.1) in exchange for `off` and shadow costing no node startup on the foreground path.
- We accept a second PreToolUse registration in `hooks.json` that is guarded off in every mode but enforce, in exchange for enforce being a synchronous hook without a second install step.
- We accept redacting the full text of large Write contents before cutting (O(n) regex over up to hundreds of KB) in exchange for the order being a type.
- We accept a committed `dist/` in exchange for zero install-time build; plugin install runs no scripts.
- We accept that the log's `unresolved` label conflates "user said no", "enforce denied", and "session ended", in exchange for never reading the transcript.
- We accept that Vercel cannot be pinned to `jev-1.13.0` as far as the grounding shows, in exchange for keeping it as a backend for users without direct-API access; the report lists the models seen.
- We accept `evaluate` for every WebFetch and MCP call, which in shadow mode sends more to Jev, in exchange for no rule that would silently approve a network action.

## Alternatives considered

1. **A long-lived local daemon, hooks POST to it (`type: "http"`).** No node startup per call, in-memory join, one process holds the key. Rejected: `http` hooks block like command hooks so shadow still costs a round trip, the daemon needs a lifecycle and a port, the join lives in memory until a crash, and the surface grows a server. It hides less than it exposes.
2. **Wrap jev-axi as a dependency and ship it as a plugin.** Fastest path and the question pack is already there. Rejected: the `&` bypass, truncate-before-redact, the SDK dependency, and no shadow mode are in its core, so we would be patching upstream from outside; the brief's item 2 is to harden upstream *with* this project's data, not to fork it now.
3. **One sync PreToolUse hook that forks a detached child for shadow.** One registration, no shell guard. Rejected: shadow's "cannot affect the session" would rest on the parent printing nothing, and the parent still pays node startup on the foreground path. The `async` flag is the structural guarantee the brief asks for.
4. **Mode as a non-sensitive `userConfig` option with `options: [off, shadow, enforce]`.** Nicer UX (`/config` panel), and `CLAUDE_PLUGIN_OPTION_MODE` reaches the shell guard. Rejected for v0.1: it is Claude-only (Codex and pi have no `userConfig`), whether a change applies without `/reload-plugins` is unverified, and the data-dir file works identically on every host.

## Implementation reconciliation

Empty until Phase D.

## Open questions and risks

- Does the Vercel `/typesafe` path accept a versioned model id (`typesafe-ai/jev-1.13.0`)? If not, is Vercel acceptable given requirement 3's pin, with drift visible only through the direct and OpenRouter backends?
- What are the exact classifier rule labels beyond `[Data Exfiltration]` and `[Irreversible Local Destruction]`? `RULE_TO_HAZARD` needs the auto-mode-config "Review denials" list to fill the "same rule" column.
- Does `MultiEdit` still exist as a tool name in 2.1.280? If not, the matcher and `TOOL_PARSERS` row are dead weight.
- Is `CLAUDE_PLUGIN_DATA` exported to the hook environment before the directory exists ("created on first reference")? The guard handles absence as `off`, but `jev-shadow mode shadow` from the Bash tool needs the glob fallback in `dataDir`.
- Should `cd` outside the project make the whole command `evaluate`, or only the segments after it? The sketch chooses the whole command.
- Is a committed `dist/` acceptable for a build-in-public repo, or should the marketplace entry use a `command` source that runs `tsc`?
- Log growth: at one 600-byte line per hook event, a busy week is a few MB. Rotation in v0.2, or should `report` accept a date window now?

## Next implementation step

Write `src/rules.ts` for real (`splitSegments`, `hasFlag`, the table) against `test/fixtures/commands.json`, since every other module consumes `ToolCall` and the six named bypasses are the first behavior the project has to prove.
