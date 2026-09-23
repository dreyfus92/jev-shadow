import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIP, REDACTED_MARK, clip, fromHost, redact, excerpt, scriptRefs, fingerprint, toJevState } from "../src/egress.js";
import type { Action, EventContext } from "../src/core.js";
import { fixture, leaks, loadCorpus } from "./helpers.js";

interface Leak { name: string; input: string; secret: string; keep?: string[] }
const corpus = loadCorpus() as Leak[];

for (const { name, input, secret, keep } of corpus) {
  test(`redact: ${name}`, () => {
    const out = redact(fromHost(input));
    if (secret) assert.ok(!leaks(out, secret), `leaked in: ${out.slice(0, 300)}`);
    for (const k of keep ?? []) assert.ok(out.includes(k), `lost verdict-relevant text ${JSON.stringify(k)} in: ${out}`);
    assert.equal(redact(fromHost(out)), out, "redact is idempotent");
  });
}

test("token straddling the clip: redact-then-clip holds, clip-then-redact leaks (the jev-axi bug class)", () => {
  const c = corpus.find((c) => c.name.startsWith("github token straddling"));
  assert.ok(c);
  assert.ok(!leaks(clip(redact(fromHost(c.input)), 3000), c.secret));
  assert.ok(leaks(redact(fromHost(c.input.slice(0, 3000))), c.secret), "the corpus must reproduce the bug when the order is wrong");
});

test("PEM straddling the clip: the unterminated-block rule covers even a block cut before its END marker", () => {
  const c = corpus.find((c) => c.name.startsWith("pem straddling"));
  assert.ok(c);
  assert.ok(!leaks(clip(redact(fromHost(c.input)), 3000), c.secret));
  assert.ok(!leaks(redact(fromHost(c.input.slice(0, 3000))), c.secret));
});

test("redact keeps shell operators after a password value", () => {
  const out = redact(fromHost("deploy --password=DSKFQs1DxBA9;rm -rf ~ && ls | wc"));
  assert.equal(out, `deploy --password=${REDACTED_MARK};rm -rf ~ && ls | wc`);
});

test("unterminated PEM redacts to the end of the text", () => {
  const out = redact(fromHost("cat <<EOF\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n"));
  assert.equal(out, `cat <<EOF\n${REDACTED_MARK}`);
});

test("clip: under the limit is identity, over it appends the count and never splits a marker or a surrogate pair", () => {
  const short = redact(fromHost("abc"));
  assert.equal(clip(short, 3), short);
  const marked = redact(fromHost(`x=${"a".repeat(10)} TOKEN=abcdefghijklmnop rest`));
  const markAt = marked.indexOf(REDACTED_MARK);
  const cut = clip(marked, markAt + 4);
  assert.equal(cut, `${marked.slice(0, markAt)}…(+${marked.length - markAt} chars)`);
  const emoji = redact(fromHost("ab😀cd"));
  assert.equal(clip(emoji, 3), "ab…(+4 chars)");
});

const ctx: EventContext = {
  host: "claude-code", session: "s" as EventContext["session"], toolUseId: "t" as EventContext["toolUseId"],
  tool: "Bash" as EventContext["tool"], permissionMode: "default",
  cwd: "/p" as EventContext["cwd"], projectRoot: "/p" as EventContext["projectRoot"], agentId: null,
};
const shell = (command: string): Action => ({ kind: "shell", dialect: "posix", command: fromHost(command) });

test("toJevState: scripts are capped, redacted and clipped; absent scripts leave the field out", () => {
  const scripts = new Map([
    ["./a.sh", fromHost(`export TOKEN=abcdefghijklmnop\n${"y".repeat(5000)}`)],
    ["./b.sh", fromHost("echo b")], ["./c.sh", fromHost("echo c")], ["./d.sh", fromHost("echo d")],
  ]);
  const state = toJevState(shell("./a.sh"), ctx, scripts);
  assert.ok("command" in state && state.local_scripts_run);
  assert.deepEqual(Object.keys(state.local_scripts_run), ["./a.sh", "./b.sh", "./c.sh"]);
  assert.ok(!state.local_scripts_run["./a.sh"]?.includes("abcdefghijklmnop"));
  assert.ok((state.local_scripts_run["./a.sh"]?.length ?? 0) <= CLIP.script + 20);
  assert.ok(!("local_scripts_run" in toJevState(shell("ls"), ctx, new Map())));
});

test("scriptRefs finds in-project scripts a posix command runs and nothing for other actions", () => {
  assert.deepEqual(scriptRefs(shell("bash scripts/deploy.sh && ./run && node x.mjs; python3 tools/gen.py")), ["scripts/deploy.sh", "./run", "x.mjs", "tools/gen.py"]);
  assert.deepEqual(scriptRefs(shell("ls -la")), []);
  assert.deepEqual(scriptRefs({ kind: "shell", dialect: "powershell", command: fromHost("./x.ps1") }), []);
});

test("excerpt is one redacted line of at most the excerpt budget", () => {
  const e = excerpt(shell(`curl -H "Authorization: Bearer RelOxOPbbNcRV7vZgGEFW5jcnTAOivg3QxvEXHJX"\n  ${"x".repeat(400)}`));
  assert.ok(!e.includes("\n") && !leaks(e, "RelOxOPbbNcRV7vZgGEFW5jcnTAOivg3QxvEXHJX"));
  assert.ok(e.length <= CLIP.excerpt + 20);
});

test("fingerprint is key-order independent and changes with the state", () => {
  const a = toJevState(shell("ls"), ctx, new Map());
  const b = toJevState(shell("ls"), { ...ctx, cwd: ctx.cwd }, new Map());
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(toJevState(shell("ls -a"), ctx, new Map())));
  assert.match(fingerprint(a), /^[0-9a-f]{64}$/);
});
