/**
 * The shell. Argv, stdin, stdout, fs, network, clock. Everything here is wiring; every decision
 * is made in core.ts. This is also the only file that knows which HostAdapter is active.
 *
 *   jev-shadow hook observe --data <dir>    async hooks (all four events)
 *   jev-shadow hook gate    --data <dir>    sync PreToolUse hook
 *   jev-shadow report [--log <path>]
 *   jev-shadow mode <off|shadow|enforce>    writes ~/.config/jev-shadow/config.json; `off` is the kill switch
 */
import { parseArgs } from "node:util";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix } from "node:path";
import { actingPosture, assess, decide } from "./core.js";
import { CLIP, fromHost } from "./egress.js";
import { parseConfig, withMode } from "./config.js";
import { Deadline, ENDPOINTS, ask, mockFetch } from "./jev.js";
import { attemptRecord, decode, encode, labelRecord, logPath } from "./log.js";
import { insideDir } from "./rules.js";
import { join, render, summarize } from "./report.js";
const USAGE = `usage:
  jev-shadow hook observe --data <dir>
  jev-shadow hook gate --data <dir>
  jev-shadow report [--log <path>]
  jev-shadow mode <off|shadow|enforce>
`;
export async function main(argv, io, host) {
    let parsed;
    try {
        parsed = parseArgs({ args: [...argv], options: { data: { type: "string" }, log: { type: "string" } }, allowPositionals: true });
    }
    catch (e) {
        io.stderr(`${String(e)}\n${USAGE}`);
        return 1;
    }
    const [command, sub] = parsed.positionals;
    const { data, log } = parsed.values;
    if (command === "hook" && (sub === "observe" || sub === "gate") && data !== undefined) {
        const dataDir = data;
        try {
            if (sub === "gate")
                await runGate(io, host, dataDir);
            else
                await runObserver(omitStdout(io), host, dataDir);
        }
        catch (e) {
            io.stderr(`jev-shadow ${sub}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
        }
        return 0;
    }
    if (command === "report" && sub === undefined) {
        try {
            io.stdout(runReport(io, log !== undefined ? log : discoverLog(io)));
            return 0;
        }
        catch (e) {
            io.stderr(`jev-shadow report: ${e instanceof Error ? e.message : String(e)}\n`);
            return 1;
        }
    }
    if (command === "mode" && isMode(sub)) {
        const path = configPath(io.env);
        io.replaceText(path, withMode(io.readText(path), sub));
        io.stderr(`jev-shadow: mode ${sub} written to ${path}\n`);
        return 0;
    }
    io.stderr(USAGE);
    return 1;
}
function isMode(v) {
    return v === "off" || v === "shadow" || v === "enforce";
}
function omitStdout(io) {
    const { stdout: _stdout, ...rest } = io;
    return rest;
}
/** `$JEV_SHADOW_CONFIG`, else `$XDG_CONFIG_HOME/jev-shadow/config.json`, else `~/.config/jev-shadow/config.json`. */
export function configPath(env) {
    const explicit = env["JEV_SHADOW_CONFIG"];
    if (explicit)
        return explicit;
    const home = env["HOME"] ?? homedir();
    const base = env["XDG_CONFIG_HOME"] ?? `${home}/.config`;
    return `${base}/jev-shadow/config.json`;
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
export async function runGate(io, host, dataDir) {
    const config = parseConfig(io.readText(configPath(io.env)), io.env);
    if (config.mode !== "enforce")
        return;
    const event = host.parse(await io.readStdin(), io.env);
    if (event.kind === "unsupported" || event.kind !== "attempt")
        return;
    if (actingPosture(config.mode, event) !== "gate")
        return;
    const decision = await judge(io, host, config, event, "gate", dataDir);
    io.stdout(host.render(decision));
}
/**
 * Async hooks, all four events. Same steps as the gate with posture "observe", the observe
 * budget, and no step 8. denied / ran events skip assess and append a labelRecord.
 */
export async function runObserver(io, host, dataDir) {
    const config = parseConfig(io.readText(configPath(io.env)), io.env);
    if (config.mode === "off")
        return;
    const event = host.parse(await io.readStdin(), io.env);
    if (event.kind === "unsupported")
        return;
    if (actingPosture(config.mode, event) !== "observe")
        return;
    if (event.kind === "attempt") {
        await judge(io, host, config, event, "observe", dataDir);
        return;
    }
    io.appendLine(logPath(dataDir), encode(labelRecord(event, new Date(io.now()).toISOString())));
}
/** assess, decide, and write the attempt record before returning, so a host kill at the timeout still leaves the evidence. */
async function judge(io, host, config, event, posture, dataDir) {
    const deadline = Deadline.fromProcessStart(io.startedAt, posture === "gate" ? config.budgets.gate : config.budgets.observe);
    const backend = resolveBackend(io, host, config);
    const scripts = readScripts(io);
    const assessment = await assess(event, {
        ask: (state) => ask(state, backend, deadline, io.now),
        readScripts: (refs, ctx) => scripts(refs, ctx.projectRoot),
    });
    const decision = decide(assessment, config.policy);
    const at = new Date(io.now()).toISOString();
    const wallMs = Math.round(io.now() - io.startedAt);
    io.appendLine(logPath(dataDir), encode(attemptRecord(event, assessment, decision, { at, posture, backend: backend.id, wallMs })));
    return decision;
}
/** Paid backends go through `io.fetch`; the mock answers from its fixtures file and never touches the network. */
function resolveBackend(io, host, config) {
    const { backend } = config;
    if (backend.kind === "mock") {
        let fixtures = [];
        try {
            fixtures = JSON.parse(io.readText(backend.fixtures) ?? "[]");
        }
        catch {
            fixtures = [];
        }
        return { id: "mock", url: "mock:", model: "jev-1.13.0", key: null, fetch: mockFetch(Array.isArray(fixtures) ? fixtures : []) };
    }
    return { id: backend.kind, ...ENDPOINTS[backend.kind], key: host.apiKey(io.env), fetch: io.fetch };
}
/** decode -> join -> summarize -> render. */
export function runReport(io, log) {
    const text = io.readText(log);
    if (text === undefined)
        throw new Error(`no log at ${log}`);
    const { records, malformed } = decode(text);
    const [caveat, ...rest] = render(summarize(join(records), malformed)).split("\n");
    return [caveat, `log ${log}`, ...rest].join("\n");
}
/**
 * `$CLAUDE_PLUGIN_DATA/log.jsonl` when set (inside Claude Code), else the single match of
 * `~/.claude/plugins/data/jev-shadow-*\/log.jsonl`. Several matches -> ask for `--log`.
 */
export function discoverLog(io) {
    const data = io.env["CLAUDE_PLUGIN_DATA"];
    if (data)
        return logPath(data);
    const root = `${io.env["HOME"] ?? homedir()}/.claude/plugins/data`;
    let entries = [];
    try {
        entries = readdirSync(root);
    }
    catch {
        entries = [];
    }
    const matches = entries.filter((name) => name.startsWith("jev-shadow-")).map((name) => logPath(`${root}/${name}`));
    const [only, ...more] = matches;
    if (only === undefined)
        throw new Error(`no log found under ${root}; pass --log <path>`);
    if (more.length > 0)
        throw new Error(`several logs found under ${root}; pass --log <path>`);
    return only;
}
/**
 * Read in-project scripts a command runs, for `local_scripts_run`. Size cap 512 KB, regular
 * files only, inside ctx.projectRoot only. Returns Raw: redaction happens in egress.ts.
 */
export function readScripts(io) {
    return (refs, root) => {
        const scripts = new Map();
        for (const ref of refs.slice(0, CLIP.maxScripts)) {
            const abs = posix.resolve(root, ref);
            if (!insideDir(abs, root))
                continue;
            const text = io.readText(abs);
            if (text === undefined || text.length > SCRIPT_BYTES_MAX)
                continue;
            scripts.set(ref, fromHost(text));
        }
        return scripts;
    };
}
const SCRIPT_BYTES_MAX = 512_000;
export function nodeIo() {
    return {
        env: process.env,
        startedAt: performance.timeOrigin,
        now: () => performance.timeOrigin + performance.now(),
        readStdin: async () => {
            const chunks = [];
            for await (const chunk of process.stdin)
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            return Buffer.concat(chunks).toString("utf8");
        },
        readText: (path) => {
            try {
                return readFileSync(path, "utf8");
            }
            catch {
                return undefined;
            }
        },
        appendLine: (path, line) => {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, line, { flag: "a" });
        },
        replaceText: (path, text) => {
            mkdirSync(dirname(path), { recursive: true });
            const tmp = `${path}.${process.pid}.tmp`;
            writeFileSync(tmp, text);
            const fd = openSync(tmp, "r");
            try {
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(tmp, path);
        },
        fetch: globalThis.fetch,
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
    };
}
