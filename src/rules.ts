/**
 * The local rule table. Decides which attempts never leave the machine.
 *
 * Rules run on raw text, not redacted text: a redaction pattern that swallowed `;rm -rf ~`
 * would make a dangerous command look routine. This module reads secrets but emits none; its
 * output is a RuleId or a Miss, never text.
 *
 * "Routine" never approves anything. It only means "don't ask Jev". The host's own permission
 * flow still runs, in every mode.
 */
import type { Action, AbsPath, EventContext } from "./core.js";

/** Stable ids, logged with every routine attempt so the report can blame a rule. */
export type RuleId = `${string}.${string}`;

export type Triage =
  | { readonly kind: "routine"; readonly rule: RuleId }
  | { readonly kind: "judge"; readonly miss: Miss };

/** Why Jev is asked. Logged, so the report can show which gaps drive traffic. */
export type Miss =
  | { readonly kind: "opaque"; readonly why: OpaqueReason }
  | { readonly kind: "unlisted"; readonly argv0: string }
  | { readonly kind: "refused"; readonly rule: RuleId }
  | { readonly kind: "unsafe_redirect" }
  | { readonly kind: "sensitive_path" }
  | { readonly kind: "outside_project" }
  | { readonly kind: "always_judged" }; // fetch, mcp, other, powershell

// ------------------------------------------------------------------ shell splitting

/** A shell word. `literal` is false when it contains an unquoted `$ * ? [ { ~`. */
export interface Word {
  readonly text: string;
  readonly literal: boolean;
}

export type Redirect =
  | { readonly kind: "fd_dup" }                       // 2>&1, >&2
  | { readonly kind: "devnull" }                      // >/dev/null, 2>/dev/null, &>/dev/null
  | { readonly kind: "read"; readonly from: Word }    // < file
  | { readonly kind: "write"; readonly to: Word };    // > f, >> f, &> f, >| f  (never routine)

export interface Segment {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
}

export type OpaqueReason =
  | "substitution"      // $( ) ` ` <( ) >( )
  | "unbalanced_quote"
  | "heredoc"           // << <<< (content can be piped anywhere)
  | "grouping"          // ( ) { } subshells and groups
  | "ansi_c_quote";     // $'...'

export type Split =
  | { readonly kind: "segments"; readonly segments: readonly Segment[] }
  | { readonly kind: "opaque"; readonly why: OpaqueReason };

/**
 * Contract: every byte of `command` lands in exactly one segment, or the result is `opaque`.
 * Anything the tokenizer does not fully understand is opaque, and opaque is never routine,
 * so a parser gap sends more to Jev instead of letting a command through unseen.
 */
export function splitShell(command: string): Split {
  // TODO single left-to-right scan with a quote state (none | single | double):
  //  - in none state, match operators longest-first:
  //      "&&" "||" "|&" ";;"          -> separator
  //      "&>" ">>" ">|" "N>&M" ">&N"  -> redirect (parse the target word next)
  //      "<<" "<<<"                   -> opaque heredoc
  //      "&" "|" ";" "\n"             -> separator. Lone `&` splits: `ls & rm -rf ~` is two segments
  //      ">" "<"                      -> redirect
  //      "$(" "`" "<(" ">("           -> opaque substitution
  //      "(" ")" "{" "}" at word start -> opaque grouping
  //      "$'"                         -> opaque ansi_c_quote
  //  - in double quotes: "$(" and "`" are still opaque; "\\" escapes the next char
  //  - "\\\n" is a line continuation, not a separator
  //  - end of input in a quote state -> opaque unbalanced_quote
  //  - a word is literal iff no unquoted `$ * ? [ { ~` appeared in it
  //  - empty segments (`;;`, trailing `&`) are dropped
  throw new Error("not implemented");
}

// ------------------------------------------------------------------ the table

/**
 * A flag to look for among a segment's args.
 *   short  one letter, also found inside clusters and with attached values: `-i`, `-Ei`, `-i.bak`
 *   long   `--name` or `--name=value`
 *   word   an exact single-dash long option, for `find -fprintf`, `find -delete`
 * Over-matching is safe (more goes to Jev); under-matching is the bug class this fixes.
 */
export type Flag =
  | { readonly short: string }
  | { readonly long: string }
  | { readonly word: string };

/** Named argument predicates, so rules stay serializable data. */
export type ArgCheck =
  | "any"
  | "literal"              // every arg is a literal word
  | "rebuildable_targets"  // every non-flag arg is a literal rebuildable dir (node_modules, dist, ...)
  | "inside_project"       // the single arg resolves inside ctx.projectRoot (for `cd`)
  | "project_script"       // `run <name>` needs <name> in PROJECT_SCRIPTS; other args are flags
  | "flags_only"           // no positional args (`npm ci`, `npm install` with no package names)
  | "sed_no_write_exec";   // no `w`/`W` (write file) or GNU `e` (run shell) command or `s///w`, `s///e`
                           // flag in the script. jev-axi misses this; `sed 's/a/b/w ~/.zshrc'` writes.

export interface CommandRule {
  readonly id: RuleId;
  /** argv[0], exact, after stripping a leading path only if it resolves to the same basename. */
  readonly argv0: string;
  /** argv[1] must be in this set. Absent means no subcommand constraint. */
  readonly sub?: readonly string[];
  /** argv[1] must not start with "-" (git -c / git -C can run or retarget anything). */
  readonly subFirst?: true;
  /** Any match refuses the rule. */
  readonly forbid?: readonly Flag[];
  /** All must match, or the rule refuses (`cargo fmt` needs `--check`). */
  readonly require?: readonly Flag[];
  readonly args: ArgCheck;
}

/**
 * Built once into Map<argv0, CommandRule[]>. A segment is routine iff its argv0 is literal, its
 * redirects are fd_dup/devnull/read, and at least one rule for its argv0 passes. Lookup is one
 * map hit plus the handful of rules for that command.
 *
 * Known jev-axi gaps, each covered by a fixture in test/rules.test.ts:
 *   `ls & rm -rf ~`            split on lone `&`
 *   `sed -Ei s/a/b/ f`         short `i` inside a cluster
 *   `sort -o ~/.bashrc`        forbid short `o` / long `output`
 *   `find . -fprintf /x %p`    forbid word `-fprintf` (and -fprint, -fprint0, -fls)
 *   `git diff --output=/x`     forbid long `output` on every git read
 *   `cd / && rm -rf tmp`       `cd` is routine only into the project
 */
export const RULES: readonly CommandRule[] = [
  { id: "read.ls", argv0: "ls", args: "any" },
  { id: "read.cat", argv0: "cat", args: "any" },
  { id: "read.grep", argv0: "grep", args: "any" },
  { id: "read.rg", argv0: "rg", args: "any", forbid: [{ long: "pre" }] },
  { id: "read.head", argv0: "head", args: "any" },
  { id: "read.wc", argv0: "wc", args: "any" },
  { id: "read.echo", argv0: "echo", args: "any" },
  { id: "read.pwd", argv0: "pwd", args: "any" },
  { id: "read.jq", argv0: "jq", args: "any" },
  { id: "read.sort", argv0: "sort", args: "any", forbid: [{ short: "o" }, { long: "output" }] },
  { id: "read.sed", argv0: "sed", args: "sed_no_write_exec", forbid: [{ short: "i" }, { long: "in-place" }] },
  {
    id: "read.find", argv0: "find", args: "any",
    forbid: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].map((word) => ({ word })),
  },
  {
    id: "git.read", argv0: "git", subFirst: true, args: "any",
    sub: ["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "grep", "describe", "shortlog"],
    forbid: [{ long: "output" }, { long: "ext-diff" }],
  },
  { id: "cd.project", argv0: "cd", args: "inside_project" },
  { id: "rm.rebuildable", argv0: "rm", args: "rebuildable_targets" },
  { id: "pkg.npm_script", argv0: "npm", sub: ["test", "t", "run"], args: "project_script" },
  { id: "pkg.npm_install", argv0: "npm", sub: ["ci", "install", "i"], args: "flags_only" },
  { id: "pkg.pnpm_script", argv0: "pnpm", sub: ["test", "run"], args: "project_script" },
  { id: "cargo.check", argv0: "cargo", sub: ["test", "build", "check", "clippy"], args: "literal" },
  { id: "cargo.fmt_check", argv0: "cargo", sub: ["fmt"], require: [{ long: "check" }], args: "literal" },
  { id: "go.check", argv0: "go", sub: ["test", "build", "vet"], args: "literal" },
  { id: "npx.tools", argv0: "npx", sub: ["tsc", "vitest", "eslint", "oxlint"], forbid: [{ long: "write" }, { long: "fix" }], args: "literal" },
  // ... full table ported from jev-axi SIMPLE_READ_COMMANDS / GIT_READ / PKG_SCRIPTS, as data.
];

/** Script names treated as the project's own test and build commands. */
export const PROJECT_SCRIPTS: ReadonlySet<string> = new Set(["test", "lint", "typecheck", "check", "build", "format:check"]);

/**
 * Paths that are never routine even inside the project: they change what the agent or the
 * machine runs next. Matched against the absolute, forward-slash path.
 */
export const SENSITIVE_PATHS: readonly RegExp[] = [
  /(^|\/)\.git\/(hooks|config)(\/|$)/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.(ssh|gnupg|aws|kube|docker)(\/|$)/,
  /\.(bash|zsh|fish)rc$|\.(bash_)?profile$|\.envrc$/,
  /^\/etc\//,
];

/** Pure. The whole local fast path. */
export function triage(action: Action, ctx: EventContext, rules: readonly CommandRule[] = RULES): Triage {
  // TODO
  // shell posix -> splitShell(command); opaque -> judge opaque
  //                every segment: redirects safe? argv0 literal? some rule for argv0 passes?
  //                first failing segment's Miss wins (unsafe_redirect | unlisted | refused)
  // shell powershell, fetch, mcp, other -> judge always_judged
  // write -> SENSITIVE_PATHS match -> judge sensitive_path
  //          inside ctx.projectRoot or os tmpdir -> routine "edit.in_project"
  //          else -> judge outside_project
  throw new Error("not implemented");
}

/** Exposed for tests of the `inside_project` / `rebuildable_targets` checks. */
export function insideDir(path: string, dir: AbsPath): boolean {
  throw new Error("not implemented");
}
