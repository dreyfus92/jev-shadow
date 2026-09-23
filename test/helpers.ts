import type { Io } from "../src/cli.js";
import type { AbsPath } from "../src/core.js";
import type { LogRecord } from "../src/log.js";
import type { Config } from "../src/config.js";
import type { MockFixture } from "../src/jev.js";

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
  throw new Error("not implemented");
}

/** Reads test/fixtures/<rel> as text. Claude fixtures are real stdin captured from 2.1.280. */
export function fixture(rel: string): string {
  throw new Error("not implemented");
}

/** A real PreToolUse stdin fixture with `tool_input.command` replaced. */
export function preBash(command: string, overrides?: { permission_mode?: string }): string {
  throw new Error("not implemented");
}

/** True when any 8-char window of `secret` appears in `text`. */
export function leaks(text: string, secret: string): boolean {
  throw new Error("not implemented");
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
