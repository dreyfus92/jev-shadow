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
import { tmpdir } from "node:os";
import { posix } from "node:path";
/**
 * Contract: every byte of `command` lands in exactly one segment, or the result is `opaque`.
 * Anything the tokenizer does not fully understand is opaque, and opaque is never routine,
 * so a parser gap sends more to Jev instead of letting a command through unseen.
 */
export function splitShell(command) {
    const segments = [];
    let words = [];
    let redirects = [];
    let text = "";
    let literal = true;
    let inWord = false;
    let quote = "none";
    let pending = null;
    const endWord = () => {
        if (!inWord)
            return;
        const word = { text, literal };
        if (pending === null)
            words.push(word);
        else if (pending === "read")
            redirects.push({ kind: "read", from: word });
        else
            redirects.push(word.text === "/dev/null" ? { kind: "devnull" } : { kind: "write", to: word });
        pending = null;
        text = "";
        literal = true;
        inWord = false;
    };
    const endSegment = () => {
        endWord();
        if (pending !== null)
            redirects.push({ kind: "write", to: { text: "", literal: false } });
        pending = null;
        if (words.length > 0 || redirects.length > 0)
            segments.push({ words, redirects });
        words = [];
        redirects = [];
    };
    const put = (ch, isLiteral = true) => {
        inWord = true;
        text += ch;
        if (!isLiteral)
            literal = false;
    };
    const opaque = (why) => ({ kind: "opaque", why });
    let i = 0;
    while (i < command.length) {
        const ch = command[i] ?? "";
        const next = command[i + 1] ?? "";
        if (quote === "single") {
            if (ch === "'")
                quote = "none";
            else
                put(ch);
            i++;
            continue;
        }
        if (quote === "double") {
            if (ch === '"')
                quote = "none";
            else if (ch === "\\" && next !== "") {
                put(next);
                i++;
            }
            else if ((ch === "$" && next === "(") || ch === "`")
                return opaque("substitution");
            else
                put(ch, ch !== "$");
            i++;
            continue;
        }
        if (ch === "\\") {
            if (next === "\n") {
                i += 2;
                continue;
            }
            put(next === "" ? ch : next);
            i += next === "" ? 1 : 2;
            continue;
        }
        if (ch === "'") {
            quote = "single";
            inWord = true;
            i++;
            continue;
        }
        if (ch === '"') {
            quote = "double";
            inWord = true;
            i++;
            continue;
        }
        if (ch === "$" && next === "'")
            return opaque("ansi_c_quote");
        if ((ch === "$" && next === "(") || ch === "`" || ((ch === "<" || ch === ">") && next === "("))
            return opaque("substitution");
        if (ch === "<" && next === "<")
            return opaque("heredoc");
        if ((ch === "(" || ch === ")" || ch === "{" || ch === "}") && !inWord)
            return opaque("grouping");
        if (ch === " " || ch === "\t" || ch === "\r") {
            endWord();
            i++;
            continue;
        }
        if (ch === "\n") {
            endSegment();
            i++;
            continue;
        }
        const two = ch + next;
        if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
            endSegment();
            i += 2;
            continue;
        }
        if (ch === "&" && next !== ">") {
            endSegment();
            i++;
            continue;
        }
        if (ch === "|" || ch === ";") {
            endSegment();
            i++;
            continue;
        }
        if (ch === ">" || ch === "<" || two === "&>") {
            const fdPrefixed = inWord && /^[0-9]+$/.test(text) && pending === null;
            if (fdPrefixed) {
                text = "";
                inWord = false;
            }
            else
                endWord();
            let j = i + (two === "&>" ? 2 : 1);
            if (command[j] === ">" || command[j] === "|")
                j++;
            if (command[j] === "&") {
                const m = /^[0-9]+|^-/.exec(command.slice(j + 1));
                if (m) {
                    redirects.push({ kind: "fd_dup" });
                    i = j + 1 + m[0].length;
                    continue;
                }
                j++;
            }
            pending = ch === "<" ? "read" : "write";
            i = j;
            continue;
        }
        put(ch, !"$*?[{~}".includes(ch));
        i++;
    }
    if (quote !== "none")
        return opaque("unbalanced_quote");
    endSegment();
    return { kind: "segments", segments };
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
export const RULES = [
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
    { id: "read.sed", argv0: "sed", args: "sed_no_write_exec", forbid: [{ short: "i" }, { long: "in-place" }, { short: "f" }, { long: "file" }] },
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
    ...["tail", "uniq", "cut", "tr", "which", "printf", "date", "stat", "file", "du", "df", "tree", "basename", "dirname",
        "realpath", "diff", "true", "nl", "column", "whoami", "uname", "egrep", "fgrep"]
        .map((argv0) => ({ id: `read.${argv0}`, argv0, args: "any" })),
    { id: "git.branch_list", argv0: "git", subFirst: true, sub: ["branch"], args: "any",
        forbid: ["d", "D", "m", "M", "c", "C"].map((short) => ({ short })).concat(["delete", "move", "copy", "force", "output"].map((long) => ({ long }))) },
    { id: "git.remote_list", argv0: "git", subFirst: true, sub: ["remote"], args: "flags_only" },
    { id: "pkg.pnpm_install", argv0: "pnpm", sub: ["install", "i"], args: "flags_only" },
    { id: "pkg.yarn_script", argv0: "yarn", sub: ["test", "run"], args: "project_script" },
    { id: "pkg.bun_script", argv0: "bun", sub: ["test", "run"], args: "project_script" },
    { id: "tools.tsc", argv0: "tsc", args: "literal" },
    { id: "tools.eslint", argv0: "eslint", forbid: [{ long: "fix" }], args: "literal" },
    { id: "tools.pytest", argv0: "pytest", args: "literal" },
    { id: "tools.mypy", argv0: "mypy", args: "literal" },
];
const BY_ARGV0 = index(RULES);
function index(rules) {
    const map = new Map();
    for (const rule of rules) {
        const list = map.get(rule.argv0);
        if (list)
            list.push(rule);
        else
            map.set(rule.argv0, [rule]);
    }
    return map;
}
/** Project build output and dependency folders that are always safe to delete and recreate. */
const REBUILDABLE = /^(\.\/)?(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|coverage|target|__pycache__|\.pytest_cache|\.venv|venv|tmp)\/?$/;
/** Script names treated as the project's own test and build commands. */
export const PROJECT_SCRIPTS = new Set(["test", "lint", "typecheck", "check", "build", "format:check"]);
/**
 * Paths that are never routine even inside the project: they change what the agent or the
 * machine runs next. Matched against the absolute, forward-slash path.
 */
export const SENSITIVE_PATHS = [
    /(^|\/)\.git\/(hooks|config)(\/|$)/,
    /(^|\/)\.claude\/settings(\.local)?\.json$/,
    /(^|\/)\.mcp\.json$/,
    /(^|\/)\.(ssh|gnupg|aws|kube|docker)(\/|$)/,
    /\.(bash|zsh|fish)rc$|\.(bash_)?profile$|\.envrc$/,
    /^\/etc\//,
];
/** Pure. The whole local fast path. */
export function triage(action, ctx, rules = RULES) {
    switch (action.kind) {
        case "shell": {
            if (action.dialect !== "posix")
                return { kind: "judge", miss: { kind: "always_judged" } };
            const split = splitShell(action.command);
            if (split.kind === "opaque")
                return { kind: "judge", miss: { kind: "opaque", why: split.why } };
            const table = rules === RULES ? BY_ARGV0 : index(rules);
            let last = "shell.empty";
            for (const segment of split.segments) {
                const verdict = triageSegment(segment, ctx, table);
                if (verdict.kind === "judge")
                    return verdict;
                last = verdict.rule;
            }
            return { kind: "routine", rule: last };
        }
        case "write": {
            if (SENSITIVE_PATHS.some((re) => re.test(action.path)))
                return { kind: "judge", miss: { kind: "sensitive_path" } };
            if (insideDir(action.path, ctx.projectRoot) || insideDir(action.path, tmpdir().replace(/\\/g, "/")) || action.path.startsWith("/tmp/")) {
                return { kind: "routine", rule: "edit.in_project" };
            }
            return { kind: "judge", miss: { kind: "outside_project" } };
        }
        case "fetch":
        case "mcp":
        case "other":
            return { kind: "judge", miss: { kind: "always_judged" } };
    }
}
function triageSegment(segment, ctx, table) {
    if (segment.redirects.some((r) => r.kind === "write"))
        return { kind: "judge", miss: { kind: "unsafe_redirect" } };
    const [head, ...rest] = segment.words;
    if (!head)
        return { kind: "routine", rule: "shell.empty" };
    const argv0 = head.literal && head.text.startsWith("/") ? posix.basename(head.text) : head.text;
    const candidates = head.literal ? table.get(argv0) ?? [] : [];
    if (candidates.length === 0)
        return { kind: "judge", miss: { kind: "unlisted", argv0: commandWord(argv0) } };
    for (const rule of candidates)
        if (passes(rule, rest, ctx))
            return { kind: "routine", rule: rule.id };
    return { kind: "judge", miss: { kind: "refused", rule: candidates[0]?.id ?? "shell.empty" } };
}
/**
 * The logged argv0 is a command word or a `NAME=` class, never the rest of the head token: a
 * `TOKEN=ghp_...` or `fetch('...?key=...')` head would otherwise carry the secret into the log.
 */
function commandWord(head) {
    if (/^[\w.+-]+$/.test(head))
        return head;
    const assignment = /^([A-Za-z_]\w*)=/.exec(head);
    return assignment?.[1] !== undefined ? `${assignment[1]}=` : "<non-word>";
}
function passes(rule, args, ctx) {
    const sub = args[0];
    if (rule.subFirst && sub && sub.text.startsWith("-"))
        return false;
    if (rule.sub && !(sub && sub.literal && rule.sub.includes(sub.text)))
        return false;
    if (rule.forbid?.some((flag) => args.some((a) => matchesFlag(flag, a))))
        return false;
    if (rule.require?.some((flag) => !args.some((a) => matchesFlag(flag, a))))
        return false;
    return checkArgs(rule, rule.sub ? args.slice(1) : args, rule.sub ? sub?.text ?? "" : "", ctx);
}
function matchesFlag(flag, word) {
    const t = word.text;
    if ("word" in flag)
        return t === flag.word;
    if ("long" in flag)
        return t === `--${flag.long}` || t.startsWith(`--${flag.long}=`);
    return /^-[^-]/.test(t) && t.slice(1).includes(flag.short);
}
function checkArgs(rule, args, sub, ctx) {
    const isFlag = (w) => w.text.startsWith("-");
    switch (rule.args) {
        case "any":
            return true;
        case "literal":
            return args.every((a) => a.literal);
        case "flags_only":
            return args.every(isFlag);
        case "rebuildable_targets": {
            const targets = args.filter((a) => !isFlag(a));
            return targets.length > 0 && targets.every((a) => a.literal && REBUILDABLE.test(a.text));
        }
        case "inside_project": {
            const [target, ...more] = args;
            if (!target || more.length > 0 || !target.literal)
                return false;
            return insideDir(posix.resolve(ctx.cwd, target.text), ctx.projectRoot);
        }
        case "project_script": {
            if (sub !== "run")
                return args.every(isFlag);
            const [name, ...more] = args;
            return name !== undefined && name.literal && PROJECT_SCRIPTS.has(name.text) && more.every(isFlag);
        }
        case "sed_no_write_exec":
            return sedScripts(args).every((script) => script.literal && !sedWritesOrExecs(script.text));
    }
}
/** The script arguments of a sed invocation: each `-e`/`--expression` value, or the first positional. */
function sedScripts(args) {
    const scripts = [];
    let explicit = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a)
            continue;
        if (a.text === "--expression" || a.text === "-e") {
            explicit = true;
            const v = args[i + 1];
            if (v) {
                scripts.push(v);
                i++;
            }
            continue;
        }
        if (a.text.startsWith("--expression=")) {
            explicit = true;
            scripts.push({ text: a.text.slice(13), literal: a.literal });
            continue;
        }
        const cluster = /^-([^-]*)e(.*)$/.exec(a.text);
        if (cluster) {
            explicit = true;
            if (cluster[2] !== undefined && cluster[2] !== "")
                scripts.push({ text: cluster[2], literal: a.literal });
            else {
                const v = args[i + 1];
                if (v) {
                    scripts.push(v);
                    i++;
                }
            }
            continue;
        }
    }
    if (!explicit) {
        const first = args.find((a) => !a.text.startsWith("-"));
        if (first)
            scripts.push(first);
    }
    return scripts;
}
/**
 * True when a sed script contains a command that writes a file (`w`, `W`, `s///w`) or runs a
 * shell (GNU `e`, `s///e`), or anything this scanner does not understand. Addresses, `s` and `y`
 * bodies with any delimiter, and the read-only commands are walked; the rest refuses.
 */
function sedWritesOrExecs(script) {
    let i = 0;
    const n = script.length;
    const skipDelimited = (delim) => {
        while (i < n) {
            const c = script[i];
            if (c === "\\") {
                i += 2;
                continue;
            }
            i++;
            if (c === delim)
                return true;
        }
        return false;
    };
    while (i < n) {
        const c = script[i] ?? "";
        if (c === " " || c === "\t" || c === ";" || c === "\n" || c === "{" || c === "}") {
            i++;
            continue;
        }
        if (/[0-9$,~+!]/.test(c)) {
            i++;
            continue;
        }
        if (c === "/") {
            i++;
            if (!skipDelimited("/"))
                return true;
            continue;
        }
        if (c === "\\") {
            const d = script[i + 1];
            if (!d)
                return true;
            i += 2;
            if (!skipDelimited(d))
                return true;
            continue;
        }
        if (c === "s" || c === "y") {
            const d = script[i + 1];
            if (!d)
                return true;
            i += 2;
            if (!skipDelimited(d) || !skipDelimited(d))
                return true;
            while (i < n && script[i] !== ";" && script[i] !== "\n" && script[i] !== "}") {
                if (script[i] === "w" || script[i] === "e")
                    return true;
                i++;
            }
            continue;
        }
        if ("pdnNgGhHxqQ=lzDPF".includes(c)) {
            i++;
            continue;
        }
        if (c === "#" || c === "a" || c === "i" || c === "c" || c === "r" || c === "R") {
            while (i < n && script[i] !== "\n")
                i++;
            continue;
        }
        if (c === "b" || c === "t" || c === "T" || c === ":") {
            while (i < n && script[i] !== ";" && script[i] !== "\n")
                i++;
            continue;
        }
        return true;
    }
    return false;
}
/** Exposed for tests of the `inside_project` / `rebuildable_targets` checks. */
export function insideDir(path, dir) {
    const rel = posix.relative(posix.resolve(dir), posix.resolve(dir, path));
    return rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel));
}
