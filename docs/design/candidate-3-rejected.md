# jev-shadow v0.1 — design

## Problem

Build a Claude Code plugin that runs TypeSafe Jev as a shadow-first decision
layer on tool calls: it asks Jev the same five-hazard question pack jev-axi
asks, logs Jev's verdict next to whatever Claude Code's auto-mode classifier
actually did, and produces a report on agreement — with zero latency and zero
ability to affect the session, because Jev has never been independently
calibrated and auto mode already gates the hazards a Jev gate would check.
Only once that data exists does an `enforce` mode (a real gate, for hosts
with no classifier — Manual mode, `dontAsk`, Codex, pi) become worth
shipping.

The shape is non-obvious for three reasons the grounding surfaced, not just
"write a PreToolUse hook":

- **Shadow and enforce must share evidence-scoring code but never share
  failure behavior.** They ask the same question, at the same thresholds, so
  the report's numbers mean what they claim to mean — but shadow must be
  structurally incapable of blocking, and enforce must have an explicit,
  documented answer for "Jev didn't respond in time." A hook family that
  fails open by default (every CLI hook type does, per
  explorer-claude-surfaces.md) makes "shadow is safe" free and "enforce is
  safe" something the design has to earn on purpose.
- **The reference implementation (jev-axi) has known, confirmed bugs** in
  exactly the local fast path and redaction pipeline this design is supposed
  to improve on: `&` not split, `sed -Ei` not recognized as in-place,
  `sort -o` and `find -fprintf` missed as writes, `git diff --output`
  escaping the read-only allowance, and — the serious one — truncation
  running before redaction, which leaked 2,864 raw PEM key characters in a
  measured test. These are constraints on the shape, not just fixes to
  apply later: the design must make the bad ordering unrepresentable, not
  just avoid it once.
- **hooks.json is static; mode is runtime state.** Claude Code decides
  whether a hook is synchronous or `async: true` at plugin-load time, from
  the manifest. But hard requirement #1 wants a single `off`/`shadow`/
  `enforce` mode a user flips without reinstalling. Those two facts don't
  reconcile unless the design registers hooks for both roles up front and
  makes the inactive one a fast no-op — a load-bearing decision this
  document names explicitly rather than leaving implicit in `bin/`.

## Usage (caller's view)

### README quickstart

```bash
# 1. Install the plugin and enable it for this repo only (never enabled by default):
claude plugin marketplace add <you>/jev-shadow
claude plugin install jev-shadow@<you>
echo '{"enabledPlugins": {"jev-shadow@<you>": true}}' >> .claude/settings.local.json

# 2. Set your TypeSafe key (skip this and use backend: "mock" to try it with no key):
#    prompted automatically on enable, or: claude plugin config jev-shadow

# 3. Turn shadow mode on — this is the actual kill switch:
cat > ~/.claude/plugins/data/jev-shadow-<you>/config.json <<'EOF'
{
  "mode": "shadow",
  "jev": { "backend": "typesafe", "deadlineMs": 6000, "apiKeyEnvVar": "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY" },
  "thresholds": { "denyHazard": 0.8, "askHazard": 0.45, "askRisk": 1.5 }
}
EOF

# 4. Work normally. Every gated Bash/Write/Edit/... call now gets a background Jev call,
#    joined against auto mode's real denials, logged to log.jsonl. Nothing in your session changes.

# 5. Read the calibration so far:
${CLAUDE_PLUGIN_ROOT}/bin/jev-shadow-report
```

### Call site 1 — the hook bin (`bin/jev-shadow.ts`, wired from `hooks/hooks.json`)

```ts
// Claude Code spawns this once per matching PreToolUse/PermissionDenied/PostToolUse event,
// with the event JSON on stdin and a role ("shadow"|"enforce"|"denied"|"posttool") as argv[2].
// The caller (Claude Code) never sees anything but stdout/exit code; everything below that is
// this plugin's own modules, not Claude Code's shape.
import { localVerdict } from "../src/core/rules.js";
import { decide, applyFailurePolicy } from "../src/core/decide.js";
import { ClaudeCodeHost } from "../src/adapters/claude-code.js";

const host = new ClaudeCodeHost();
const event = host.parseEvent(await readStdin());
if (event.kind === "pre_tool_use") {
  const local = localVerdict(event);
  // ... call Jev only when local.kind === "evaluate", then:
  const decision = decide(event, local, jevOutcome, config.thresholds);
  if (config.mode === "enforce") {
    const actionable = applyFailurePolicy(decision, config.onError);
    const output = host.emitEnforceDecision(actionable);
    process.stdout.write(output.stdout);
    process.exit(output.exitCode);
  }
}
```

### Call site 2 — a test (`bin/jev-shadow.test.ts`, using the mock backend and a hand-built fixture)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { localVerdict } from "../src/core/rules.js";
import { decide } from "../src/core/decide.js";
import { fixture, MockJevBackend } from "../src/jev.js";
import { DEFAULT_THRESHOLDS } from "../src/core/types.js";

test("git diff --output escapes the read-only allowance and reaches Jev", () => {
  const event = {
    kind: "pre_tool_use" as const,
    sessionId: "s1", toolUseId: "t1", toolName: "Bash",
    toolInput: { command: "git diff --output=/tmp/patch.diff" },
    cwd: "/repo",
  };
  const local = localVerdict(event);
  assert.equal(local.kind, "evaluate"); // was "routine" in jev-axi — the bug this table fixes
});

test("shadow scores a denied exfiltration attempt as deny, without blocking anything", async () => {
  const backend = new MockJevBackend([
    fixture("curl piping env to a URL", { tool: "Bash", commandIncludes: "curl" }, {
      ok: true,
      verdict: {
        requestedModel: "jev-1.13.0", answeredModel: "jev-1.13.0",
        hazards: { destructive: 0.1, exfiltration: 0.94, remote_code: 0.05, weakens_security: 0.02, outside_project: 0.03 },
        risk: 1.8, usage: { inputTokens: 210, outputTokens: 40 }, latencyMs: 240,
      },
    }),
  ]);
  const jevOutcome = await backend.ask(/* state built from a curl|env command */ {} as never, {} as never, 6000);
  const decision = decide({} as never, { kind: "evaluate", reason: "test" }, jevOutcome, DEFAULT_THRESHOLDS);
  assert.equal(decision.kind, "deny");
});
```

### Call site 3 — the report (`bin/jev-shadow-report.ts`, run over a fixture log)

```bash
node --test bin/jev-shadow-report.test.ts
```

```ts
import { JsonlLogStore, joinByToolUseId, buildReport, REPORT_BANDS } from "../src/log.js";

const store = new JsonlLogStore("./fixtures/sample-log.jsonl"); // no network, no config file
const cases = await joinByToolUseId(store.readAll());
const report = buildReport(cases);
assert.equal(report.hazards.find((h) => h.hazard === "exfiltration")?.agreementSampleSize > 0, true);
console.log(report.caveat); // "Auto mode's classifier is a reference for comparison, not verified ground truth."
```

## Shape

### Data structures first

The whole design is four small discriminated unions, defined once in
`src/core/types.ts`, that every other module reads and none redefines:

- **`Mode`** (`"off" | "shadow" | "enforce"`) drives **`Config`**, which is
  itself discriminated *on* `mode` — the `shadow` variant has no `onError`
  field to misconfigure, and the `enforce` variant requires one. Tracing
  "what happens when Jev times out in shadow mode" doesn't require reading
  any logic at all: the type says there's no `onError` to apply.
- **`HookEvent`** (`pre_tool_use | permission_denied | post_tool_use`) is
  the host-agnostic normalized shape every host adapter's `parseEvent`
  produces and every core function consumes. No Claude Code field name
  (`tool_use_id`, `hookSpecificOutput`, ...) appears outside
  `src/adapters/claude-code.ts`.
- **`LocalVerdict`** (`routine | evaluate`) is the local rule table's only
  output — not `allow | ask | deny`, because the local path never approves
  anything (jev-axi's invariant, kept): it only decides what skips Jev.
- **`Decision`** (`allow | ask | deny | unknown`) is `decide`'s only output.
  `unknown` is its own case, not folded into `allow`, so a Jev outage is
  visible in the type instead of silently becoming permissive by default —
  `applyFailurePolicy` is the one function that turns `unknown` into
  something actionable, and only enforce mode calls it.

Every dominant access pattern traces through these four types in at most two
hops: hook fires → `parseEvent` → `HookEvent` → `localVerdict` →
`LocalVerdict` → (maybe) `jev.ask` → `decide` → `Decision` → (enforce only)
`applyFailurePolicy` → `ActionableDecision` → `emitEnforceDecision`. No step
needs "we'll add a lookup table later" — the local rule table and the
question pack are both data from the start (`core/rules.ts`'s
`LOCAL_RULE_TABLE`, `core/questions.ts`'s `SAFETY_QUESTIONS`), not code that
grows an index once someone notices it's slow.

### Interface depth

The public surface a caller needs to learn is small: `Host.parseEvent` /
`Host.emitEnforceDecision` (two methods, one interface, per adapter),
`localVerdict`, `decide` + `applyFailurePolicy`, `JevBackend.ask` (one
method, two implementations), and `LogStore.append` / `joinByToolUseId` /
`buildReport`. That's nine functions and two tiny interfaces standing in for:
the entire jev-axi fast-path-with-five-confirmed-bugs-fixed, redact-then-
truncate ordering enforced by a type brand, a zero-dependency deadline-bound
HTTP client replacing an SDK whose retry policy caused jev-use's "never
waved through" bug, and a join-and-report pipeline over an unbounded JSONL
file. Nothing about *how* the local rule table is structured, *how* Jev's
wire JSON is shaped, or *how* the log file joins records leaks past those
nine functions — `SafetyState`, the wire request/response shape in
`src/jev.ts`, and `LogRecord`'s on-disk JSON are all private to the module
that owns them.

### Where invariants live

- **Redact before truncate**: encoded as a type, not a rule. `Redacted` is a
  branded string only `redact()` produces; `truncate()`'s parameter type is
  `Redacted`, so `truncate(rawString)` fails to compile. This is the literal
  "make it impossible to express, for example by typing" hard requirement,
  and it directly forecloses jev-axi's confirmed leak.
- **Fail-open vs fail-closed per mode**: encoded structurally in `Config`
  (shadow has no `onError`), and reinforced by *not calling*
  `applyFailurePolicy` from the shadow code path in `bin/jev-shadow.ts` —
  there's nothing to pass it even if a bug tried.
- **Total deadline**: one `AbortSignal.timeout(deadlineMs)` per Jev call, no
  retries, in `HttpJevBackend.ask`. The design's answer to "should the
  candidate use the official SDK": no — the SDK has a per-attempt timeout
  with up to 2 retries and Retry-After honored to 60s, which is exactly the
  gap that let jev-use's hook get killed by Claude Code's own timeout before
  the SDK's own worst case finished. A hand-rolled `fetch` wrapper with one
  signal and zero retries has no worst case longer than `deadlineMs`, by
  construction, and keeps the "zero runtime dependencies preferred"
  requirement — Node 20 ships `fetch` and `AbortController`.
- **Local decisions never leave the machine**: `routine` short-circuits
  before `buildSafetyState` is even called, and before any log line is
  written — not just before the network call. "Never leave the machine"
  literalized as "never gets constructed as a payload," not just "never
  gets sent."
- **Join on `tool_use_id`**: single function, `joinByToolUseId` in `src/log.ts`,
  the only place that groups the three record kinds. A case with a
  `pre_tool_use` line and neither a `permission_denied` nor `post_tool_use`
  line is explicitly excluded from metrics (not counted as an implicit
  allow) — incomplete data stays visibly incomplete.

### The hooks.json / mode reconciliation

Two `PreToolUse` handlers are registered on the same matcher: one
`async: true` (the shadow role) and one synchronous with an 8-second timeout
(the enforce role). Both fire on every matching call, in parallel, regardless
of which mode is configured. Each checks the runtime `Config`'s `mode` first
and exits 0 with no output if it isn't the mode it's for. This is the only
way to satisfy "shadow uses async hooks and cannot affect the session by
construction" (true of the `async: true` entry whenever shadow is active)
*and* "mode is switched by editing a config file, not by reinstalling the
plugin" — hooks.json can't be conditional on `${user_config.*}` for the
`async` field, so the condition moves into the process each entry spawns.
The cost is a config-file read on every matching tool call even when mode is
`off`; that read is the kill switch's actual enforcement point, so it has to
happen regardless of mode, and it's cheap (one small JSON file, no network).
`PermissionDenied` and `PostToolUse` are registered once each, always async,
and log unconditionally except for `mode: "off"` — they're pure observation,
not gated by shadow/enforce, so the report has denial and outcome data even
while nothing else in the plugin acts on it.

### Packaging

`tsc` compiles `src/**/*.ts` and `bin/*.ts` to plain ESM `.js` under the same
relative layout (`"outDir": "."`  from a `tsconfig.json` that treats `.ts` as
the source of truth and ships only the compiled `.js` plus the two manifests
in the published plugin — the `.ts` files stay for readability and for
`node --test` against `.test.ts` files run through `tsx`/`node --experimental-
strip-types` in CI, not at runtime). `bin/jev-shadow.ts` compiles to
`bin/jev-shadow.js`; a package-time step (`chmod +x` plus a same-name copy or
symlink without the `.js` suffix, the common npm-bin pattern) produces the
extensionless `bin/jev-shadow` that `hooks/hooks.json` references via
`${CLAUDE_PLUGIN_ROOT}/bin/jev-shadow` and that `node`'s shebang line
(`#!/usr/bin/env node`) makes directly executable. `bin/jev-shadow-report`
follows the same pattern. Zero runtime `dependencies` in `package.json`
(only `devDependencies` for `typescript` and a test runner shim) — Node 20's
built-in `fetch`, `AbortController`, and `node:test` cover everything
`src/jev.ts` and the test call sites need.

### What v0.1 deliberately does not do

No per-project config resolution (one config file at
`${CLAUDE_PLUGIN_DATA}/config.json`, not a layered project/user scheme). No
retry logic anywhere. No caching of Jev verdicts. No attempt to reconcile
`hazardCertainty`'s derivation with gating thresholds — it exists for the
report only, and says so in its own doc comment, because conflating "how
sure is Jev" with "should we act" was never asked for and jev-axi doesn't do
it either.

## Tradeoffs accepted

- We accept a config-file read on every matching `PreToolUse` call (even in
  `off` mode) in exchange for a kill switch that's a runtime edit instead of
  a plugin reinstall, and for `async`'s static hooks.json placement not
  fighting runtime mode switching.
- We accept two `PreToolUse` hook registrations firing in parallel on every
  matching call (one of them almost always a fast no-op) in exchange for
  genuine `async: true` shadow semantics — a single conditionally-async hook
  isn't expressible in the plugin manifest format.
- We accept that `PermissionDenied`/`PostToolUse` logging is not gated by
  shadow/enforce (only by `off`) in exchange for a report that has denial
  and outcome data from the moment shadow mode is ever turned on, without a
  separate "observation mode" concept nobody asked for.
- We accept that `hazardCertainty` is unused by any gating path in v0.1 — it
  exists to satisfy the "certainty for a noul is a documented derivation"
  requirement for the report, and nothing more. A reader who expects it to
  feed `decide` should read its doc comment before assuming that's an
  oversight.
- We accept that `bin/jev-shadow.ts`'s `runPreToolUse` takes a boolean
  (`actAsEnforce`) alongside a `Config` that already encodes mode in its
  discriminant, which is a type wrinkle flagged directly in that file's TODO
  rather than resolved in the sketch — see Open questions.

## Alternatives considered

**One binary, one hook role, mode read entirely at runtime with a hand-rolled
"detach and don't await" instead of `async: true`.** This collapses the two
`PreToolUse` registrations into one synchronous hook that, in shadow mode,
spawns Jev's call without awaiting it and returns immediately. Rejected on
the interface-depth axis it looked like it would win: it hides the
registration-duplication complexity this design exposes in hooks.json, but
it violates hard requirement #1 literally ("Shadow uses async hooks") and
loses the actual guarantee async registration buys — Claude Code, not our
own `.catch()` discipline, is what makes an async hook's `decision` field
provably inert. A hand-rolled fire-and-forget is a promise our code has to
keep every time; `async: true` is a promise the host keeps once, in the
manifest. Smaller diff, weaker invariant — not a trade this design takes.

**Backend-specific modules (`src/jev/typesafe.ts`, `src/jev/vercel.ts`,
`src/jev/openrouter.ts`) instead of one `HttpJevBackend` parameterized by a
small lookup table.** The three backends differ only in base URL and how
they spell the model id on the wire (`explorer-jev-contract.md`'s
`WIRE_MODEL_ID` table) — everything else (request shape, response parsing,
deadline handling, error mapping) is identical. Three files would each
re-express the same `fetch`-and-parse logic with copy-pasted deadline
handling, which is exactly the kind of duplication that drifts: a bug fix to
timeout handling would need three identical edits instead of one. Rejected
because it exposes an implementation choice (which vendor) as a structural
boundary (which file) where the actual variation is two strings in a table.

**A single `Decision` type with no `"unknown"` variant, defaulting a failed
Jev call straight to `"allow"` inside `decide` itself.** This is what
jev-axi effectively does (default `--on-error auto` behaves this way) and it
would shrink `core/decide.ts` by one branch and remove
`applyFailurePolicy` entirely. Rejected because it silently makes `decide` a
mode-aware function — "allow on failure" is only the right answer for
`onError: "allow"`, one of three enforce-mode policies, and shadow mode
would have no way to report "how often was Jev unreachable" if the evidence
function already discarded that fact. Keeping `"unknown"` costs one enum
variant and one small function; folding it into `"allow"` would have cost
the report its most basic reliability number.

## Open questions and risks

- `applyFailurePolicy`'s `onError: "deny"` case needs a `HazardNoul` to
  populate `Decision`'s `deny` variant, but an availability failure isn't
  about any specific hazard. Should `Decision`'s `deny` variant widen its
  `hazard` field to `HazardNoul | "unavailable"`, or should there be a
  distinct `deny_unavailable` variant that `emitEnforceDecision` maps to the
  same wire output as a hazard deny? I left this unresolved in
  `core/decide.ts`'s TODO rather than picking arbitrarily — it's a real
  shape question, not an implementation detail.
- `bin/jev-shadow.ts`'s `runPreToolUse` takes `actAsEnforce: boolean`
  alongside a `Config` union that already encodes `shadow`/`enforce` in its
  discriminant, which means TypeScript can't actually narrow `config.onError`
  from `actAsEnforce` alone in the sketch as written. The fix is almost
  certainly "call `runPreToolUse` with the already-narrowed
  `Extract<Config, {mode:"enforce"}>` from the `enforce` role's branch in
  `main()`, and a separate narrower signature for the `shadow` role" — two
  small functions instead of one with a boolean flag. Flagged rather than
  silently fixed because it's exactly the kind of local deviation Phase D
  should reconcile against this document, not paper over.
- Is `${CLAUDE_PLUGIN_DATA}/config.json` (one file, no per-project override)
  the right scope, given the research doc's "enable it only in public OSS
  repos through `enabledPlugins`... never in the santa-ia client repos"
  guidance? `enabledPlugins` already gates *whether the hooks exist at all*
  per project/scope via `.claude/settings.local.json`; this design leaves
  `mode` itself as one global dial on top of that. If per-project mode
  matters in practice (shadow in OSS repos, off everywhere else, without
  relying on remembering to toggle `enabledPlugins` correctly), that's a
  small addition (check `${CLAUDE_PROJECT_DIR}/.claude/jev-shadow.json`
  first) deliberately deferred rather than designed speculatively.
- `MockJevBackend` fixtures match on `state.tool` and a command substring by
  default (`fixture()`'s convenience constructor). Is substring matching
  precise enough once there are more than a handful of fixtures per test
  file, or does it need exact-state matching (deep equality) to avoid a
  fixture silently matching the wrong test's call? Left as a convenience
  helper alongside the general `JevFixture.match` predicate so a test can
  opt into exact matching when substring matching gets ambiguous.

## Next implementation step

Implement `src/core/redact.ts` first — it's the smallest file, it's pure
(no I/O), it directly encodes the one hard requirement that's a leaked-secret
risk if gotten wrong (redact-before-truncate), and every other module
(`core/questions.ts`'s `buildSafetyState`, `src/log.ts`'s `sentState`) is
typed against its `Redacted` export before it can compile, which forces the
rest of the implementation to honor the ordering from the very first line of
code written after this one.
