/**
 * Everything that leaves this process (the Jev request body and every log line) is built here,
 * from `Redacted` text only. Two brands carry the ordering invariant:
 *
 *   Raw       host text as received. Only `fromHost` makes one, and only host adapters call it.
 *             Every string operation (slice, substring, concat, template) returns plain `string`,
 *             which is not `Raw`.
 *   Redacted  only `redact` makes one. `clip` accepts and returns `Redacted`.
 *
 * So `clip(raw, n)` and `redact(raw.slice(0, n))` are both type errors. Truncating unredacted
 * text cannot be written without a cast, and an eslint `no-restricted-syntax` rule bans
 * `as Raw` / `as Redacted` outside this file. test/egress.types.ts pins both with
 * `@ts-expect-error`, so the invariant is checked by `tsc`, not by review.
 *
 * Why the order matters (jev-axi safety.ts:216,226): cutting a PEM block before redaction drops
 * its END marker, the block regex no longer matches, and the key body ships.
 */
import type { Action, EventContext } from "./core.js";

declare const rawBrand: unique symbol;
declare const redactedBrand: unique symbol;
export type Raw = string & { readonly [rawBrand]: true };
export type Redacted = string & { readonly [redactedBrand]: true };

/** Host boundary only. Wraps text exactly as the host sent it. */
export function fromHost(text: string): Raw {
  throw new Error("not implemented");
}

// ------------------------------------------------------------------ pattern table

export type PatternId =
  | "pem" | "url_userinfo" | "auth_header" | "stripe" | "sk" | "google" | "gitlab" | "npm"
  | "aws" | "huggingface" | "github" | "slack" | "jwt" | "mysql_p" | "password_flag" | "assignment";

interface SecretPattern {
  readonly id: PatternId;
  /** Group 1 is kept verbatim; group 2 (or the whole match when there is no group 2) is the secret. */
  readonly re: RegExp;
}

/**
 * ORDER IS LOAD-BEARING. Earlier entries run first, on the full text.
 *   1. `pem` first: a later generic rule (e.g. `PRIVATE_KEY=...`) would eat the BEGIN line and
 *      leave the body unmatched. Unterminated blocks redact to end of text.
 *   2. Structured carriers (URL userinfo, auth headers) before vendor tokens, so the token's
 *      prefix never splits a header value.
 *   3. Vendor tokens, longest prefix first (`sk_live_` before `sk-`).
 *   4. Flag and assignment heuristics last; they are the loosest.
 * No value class may cross whitespace, a quote, a backslash, or `; & |`. Redaction must never
 * swallow a shell operator: `--password x;rm -rf ~` keeps `;rm -rf ~` visible to Jev.
 * Values that are references (`$TOKEN`, `${TOKEN}`, `%TOKEN%`, `$(pass show x)`) are kept,
 * because redaction changes verdicts (jev-use: a benign health check flipped deny -> allow).
 *
 * The leak corpus (test/fixtures/leaks.jsonl) is the spec for this table.
 */
export const PATTERNS: readonly SecretPattern[] = [
  { id: "pem", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { id: "url_userinfo", re: /(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)([^\s@/;&|"'\\]+)(?=@)/gi },
  { id: "auth_header", re: /((?:authorization|proxy-authorization|x-api-key)"?\s*[:=]\s*"?(?:(?:bearer|basic|token)\s+)?)([^\s"'\\;&|]+)/gi },
  { id: "stripe", re: /\b((?:sk|rk|pk)_(?:live|test)_)([A-Za-z0-9]{10,})/g },
  { id: "sk", re: /\b(sk-(?:proj-|ant-)?)([A-Za-z0-9_-]{16,})/g },
  { id: "google", re: /\b(AIza)([\w-]{30,})/g },
  { id: "gitlab", re: /\b(glpat-)([\w-]{20,})/g },
  { id: "npm", re: /\b(npm_)([A-Za-z0-9]{36})\b/g },
  { id: "aws", re: /\b((?:AKIA|ASIA))([0-9A-Z]{16})\b/g },
  { id: "huggingface", re: /\b(hf_)([A-Za-z0-9]{30,})\b/g },
  { id: "github", re: /\b((?:ghp|gho|ghu|ghs|ghr)_|github_pat_)([A-Za-z0-9_]{20,})/g },
  { id: "slack", re: /\b(xox[abdeoprsu]-)([A-Za-z0-9-]{10,})/g },
  { id: "jwt", re: /\b(eyJ)([\w-]{8,}\.[\w-]{8,}\.[\w-]+)/g },
  // `-p<password>` only for the mysql family: `mkdir -pv`, `ssh -p22`, `cp -p` must stay intact.
  { id: "mysql_p", re: /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n;&|]*?\s-p)([^\s"'\\;&|]+)/g },
  // `--password x`, `--password=x`, `--token x`, `--api-key=x`. A value starting with `-` is the
  // next flag (`--password-stdin -u me`), not a secret.
  { id: "password_flag", re: /((?:^|\s)--?[\w-]*(?:pass(?:wd|word)?|token|api-?key|secret)[\w-]*(?:=|\s+)"?)([^\s"'\\;&|-][^\s"'\\;&|]*)/gi },
  { id: "assignment", re: /(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"'\\;&|]+)/gi },
];

export const REDACTED_MARK = "[redacted]";

/**
 * Applies PATTERNS in order over the full text. Pure and idempotent:
 * redact(fromHost(redact(x))) === redact(x), asserted over the corpus.
 */
export function redact(text: Raw): Redacted {
  // TODO
  // let out: string = text
  // for (const p of PATTERNS) out = out.replace(p.re, (m, keep?, secret?) =>
  //   secret === undefined ? REDACTED_MARK                 // pem: whole match
  //   : isReference(secret) ? m : keep + REDACTED_MARK)
  // return out as Redacted                                 // the one sanctioned cast
  throw new Error("not implemented");
}

/**
 * The only truncation in the codebase. Cuts at `max` UTF-16 units without splitting a surrogate
 * pair or a `[redacted]` marker, and appends "…(+N chars)" so Jev knows it saw a prefix.
 */
export function clip(text: Redacted, max: number): Redacted {
  throw new Error("not implemented");
}

// ------------------------------------------------------------------ what Jev sees

/**
 * Per-field ceilings. The sum stays well under Jev's 32k-token state limit (about 9k tokens),
 * so an oversize request is not a runtime error path, it is unrepresentable.
 */
export const CLIP = {
  command: 8_000,
  content: 3_000,
  script: 4_000,
  maxScripts: 3,
  url: 2_000,
  fetchPrompt: 1_000,
  mcpInput: 4_000,
  /** The log excerpt. Keeps every log line far below PIPE_BUF (see log.ts). */
  excerpt: 200,
} as const;

/**
 * The Jev `state`. Field names match jev-axi's question instructions (`command`,
 * `local_scripts_run`, `file_path`, `content_excerpt`) so the pack is reused verbatim.
 * Every string leaf is `Redacted`.
 */
export type JevState =
  | { readonly tool: string; readonly cwd: Redacted; readonly command: Redacted; readonly local_scripts_run?: Readonly<Record<string, Redacted>> }
  | { readonly tool: string; readonly cwd: Redacted; readonly file_path: Redacted; readonly content_excerpt: Redacted }
  | { readonly tool: string; readonly cwd: Redacted; readonly url: Redacted; readonly prompt: Redacted }
  | { readonly tool: string; readonly cwd: Redacted; readonly mcp_server: string; readonly input: Redacted }
  | { readonly tool: string; readonly cwd: Redacted; readonly input: Redacted };

/** redact, then clip, per field. The only producer of JevState. */
export function toJevState(action: Action, ctx: EventContext, scripts: ReadonlyMap<string, Raw>): JevState {
  // TODO
  // shell  -> { command: clip(redact(action.command), CLIP.command),
  //             local_scripts_run: first CLIP.maxScripts of scripts, each clip(redact(s), CLIP.script) }
  // write  -> { file_path: clip(redact(fromHost(path))), content_excerpt: clip(redact(content), CLIP.content) }
  // fetch  -> { url, prompt }            mcp -> { mcp_server, input }            other -> { input }
  throw new Error("not implemented");
}

/** Relative paths of in-project scripts a shell command runs (`./x.sh`, `bash scripts/y.sh`). */
export function scriptRefs(action: Action): readonly string[] {
  throw new Error("not implemented");
}

/** One-line redacted summary for the log. Never the full input. */
export function excerpt(action: Action): Redacted {
  throw new Error("not implemented");
}

/** sha256 hex of the canonical JSON of a redacted state. Hashing raw text could leak a short secret by dictionary. */
export function fingerprint(state: JevState): string {
  throw new Error("not implemented");
}
