/**
 * The shell. Argv, stdin, stdout, fs, network, clock. Everything here is wiring; every decision
 * is made in core.ts. This is also the only file that knows which HostAdapter is active.
 *
 *   jev-shadow hook observe --data <dir>    async hooks (all four events)
 *   jev-shadow hook gate    --data <dir>    sync PreToolUse hook
 *   jev-shadow report [--log <path>]
 *   jev-shadow mode <off|shadow|enforce>    writes ~/.config/jev-shadow/config.json; `off` is the kill switch
 */
import type { AbsPath, HostAdapter, Posture } from "./core.js";
import type { Raw } from "./egress.js";

/** Everything impure, injectable. Tests pass a fake; `nodeIo` is the real one. */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** performance.timeOrigin: the Jev deadline and wallMs are measured from here. */
  readonly startedAt: number;
  now(): number;
  readStdin(): Promise<string>;
  readText(path: AbsPath): string | undefined;
  /** Single write on an O_APPEND fd. */
  appendLine(path: AbsPath, line: string): void;
  /** Write temp, fsync, rename. */
  replaceText(path: AbsPath, text: string): void;
  readonly fetch: typeof globalThis.fetch;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * The observer's IO has no stdout. An async hook's `additionalContext` and `systemMessage` ARE
 * delivered to Claude on the next turn (hooks.md "How async hooks execute"), so "shadow cannot
 * affect the session" needs more than `async: true`: the observer must be unable to print.
 * It is, because this type has nowhere to print to.
 */
export type ObserverIo = Omit<Io, "stdout">;

/**
 * Hooks always exit 0. The return type makes 2 (the only blocking exit code) unrepresentable,
 * so a bug can never turn into a block; every gate decision travels as JSON on stdout.
 */
export type ExitCode = 0 | 1;

export async function main(argv: readonly string[], io: Io, host: HostAdapter): Promise<ExitCode> {
  // TODO
  // parse argv (node:util parseArgs)
  // "hook observe" -> await runObserver(omitStdout(io), host, dataDir); return 0   (catch-all -> stderr, 0)
  // "hook gate"    -> await runGate(io, host, dataDir); return 0                   (catch-all -> stderr, 0)
  // "report"       -> io.stdout(runReport(io, logPathArg ?? discoverLog(io))); return 0
  // "mode <m>"     -> io.replaceText(configPath(io.env), withMode(io.readText(configPath), m)); return 0
  // otherwise      -> usage to stderr; return 1
  throw new Error("not implemented");
}

/**
 * Sync PreToolUse. The only function that calls `io.stdout`.
 *   1. config = parseConfig(readText(configPath), env)
 *   2. if config.mode !== "enforce" return                      (before reading stdin: ~20-30 ms node spawn, nothing else)
 *   3. event = host.parse(await io.readStdin(), env); unsupported -> return
 *   4. if actingPosture(config.mode, event) !== "gate" return   (auto mode: the observer has it)
 *   5. assessment = await assess(event, deps(config, host, Deadline.fromProcessStart(io.startedAt, config.budgets.gate)))
 *   6. decision = decide(assessment, config.policy)
 *   7. appendLine(log, encode(attemptRecord(event, assessment, decision, { posture: "gate", ... })))
 *   8. io.stdout(host.render(decision))
 * Step 7 before 8: if the host kills us at the timeout, the evidence is already written.
 */
export async function runGate(io: Io, host: HostAdapter, dataDir: AbsPath): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Async hooks, all four events. Same steps as the gate with posture "observe", the observe
 * budget, and no step 8. denied / ran events skip assess and append a labelRecord.
 */
export async function runObserver(io: ObserverIo, host: HostAdapter, dataDir: AbsPath): Promise<void> {
  throw new Error("not implemented");
}

/** decode -> join -> summarize -> render. */
export function runReport(io: Pick<Io, "readText">, log: AbsPath): string {
  throw new Error("not implemented");
}

/**
 * `$CLAUDE_PLUGIN_DATA/log.jsonl` when set (inside Claude Code), else the single match of
 * `~/.claude/plugins/data/jev-shadow-*\/log.jsonl`. Several matches -> ask for `--log`.
 */
export function discoverLog(io: Pick<Io, "env">): AbsPath {
  throw new Error("not implemented");
}

/**
 * Read in-project scripts a command runs, for `local_scripts_run`. Size cap 512 KB, regular
 * files only, inside ctx.projectRoot only. Returns Raw: redaction happens in egress.ts.
 */
export function readScripts(io: Pick<Io, "readText">): (refs: readonly string[], root: AbsPath) => ReadonlyMap<string, Raw> {
  throw new Error("not implemented");
}

export function nodeIo(): Io {
  throw new Error("not implemented");
}

type _unused = Posture;
