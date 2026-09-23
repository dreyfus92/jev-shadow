import { readFileSync } from "node:fs";
import type { Io } from "../src/cli.js";
import type { AbsPath } from "../src/core.js";
import type { LogRecord } from "../src/log.js";
import type { Config } from "../src/config.js";
import { mockFetch, type MockFixture } from "../src/jev.js";
import { DEFAULTS } from "../src/config.js";
import { decode } from "../src/log.js";

/** In-memory Io: stdin from a fixture file, config as an object, fetch = mockFetch(fixtures, seen). */
export interface FakeIo extends Io {
  readonly dataDir: AbsPath;
  stdoutText(): string;
  logText(): string;
  logRecords(): readonly LogRecord[];
  /** Every request body the mock backend received: the egress, as bytes. */
  requests(): readonly string[];
}

export function fakeIo(opts: {
  stdin: string;
  config: Partial<Config> & Pick<Config, "mode">;
  jev?: readonly MockFixture[];
  env?: Record<string, string>;
}): FakeIo {
  const files = new Map<string, string>();
  const seen: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const configPath = "/config.json";
  const dataDir = "/data" as AbsPath;
  const logFile = `${dataDir}/log.jsonl`;
  files.set(configPath, JSON.stringify(opts.config.mode === "off" ? { mode: "off" } : { ...DEFAULTS, ...opts.config }));
  const startedAt = performance.timeOrigin + performance.now();
  return {
    env: { JEV_SHADOW_CONFIG: configPath, CLAUDE_PLUGIN_OPTION_JEV_API_KEY: "test-key", ...opts.env },
    startedAt,
    now: () => performance.timeOrigin + performance.now(),
    readStdin: async () => opts.stdin,
    readText: (path) => files.get(path),
    appendLine: (path, line) => { files.set(path, `${files.get(path) ?? ""}${line}`); },
    replaceText: (path, text) => { files.set(path, text); },
    fetch: mockFetch(opts.jev ?? [], seen),
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    dataDir,
    stdoutText: () => out.join(""),
    logText: () => files.get(logFile) ?? "",
    logRecords: () => decode(files.get(logFile) ?? "").records,
    requests: () => seen,
  };
}

/** Reads test/fixtures/<rel> as text. Claude fixtures are real stdin captured from 2.1.280. */
export function fixture(rel: string): string {
  return readFileSync(new URL(`../../test/fixtures/${rel}`, import.meta.url), "utf8");
}

/** A real PreToolUse stdin fixture with `tool_input.command` replaced. */
export function preBash(command: string, overrides?: { permission_mode?: string }): string {
  const wire = JSON.parse(fixture("claude/pre-tool-use.bash.rm-home.json")) as Record<string, unknown>;
  return JSON.stringify({ ...wire, ...overrides, tool_input: { command } });
}

/** True when any 8-char window of `secret` appears in `text`. */
export function leaks(text: string, secret: string): boolean {
  if (secret.length < 8) return text.includes(secret);
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
}

/**
 * The leak corpus. On disk each secret is stored reversed under `secret_rev` and referenced as
 * `{{secret}}` inside `input`, so no scanner (GitHub push protection included) can pattern-match
 * a fake token in the fixture. It is reversed here and nowhere else.
 */
export function loadCorpus(): { name: string; input: string; secret: string; keep?: string[] }[] {
  return fixture("leaks.jsonl").trim().split("\n").map((line) => {
    const { secret_rev, input, ...rest } = JSON.parse(line) as { name: string; input: string; secret_rev: string; keep?: string[] };
    const secret = [...secret_rev].reverse().join("");
    return { ...rest, secret, input: input.replaceAll("{{secret}}", secret) };
  });
}
