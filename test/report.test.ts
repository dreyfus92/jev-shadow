import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "../src/log.js";
import { join, summarize, render } from "../src/report.js";
import { fixture } from "./helpers.js";

const { records, malformed } = decode(fixture("log.sample.jsonl"));
const joined = join(records);
const report = summarize(joined, malformed);

test("report over a fixture log: join, rates with counts, the ground-truth caveat", () => {
  const [group] = report.groups;
  assert.deepEqual(group?.overRefusal, { num: 3, den: 11 });
  assert.deepEqual(group?.highBandAccuracy, { num: 2, den: 3 });
  assert.equal(report.malformedLines, 1);
  assert.match(render(report).split("\n")[0] ?? "", /reference, not ground truth/);
});

test("join: duplicates keep the earliest record, denied beats ran and is a conflict, labels without an attempt are orphans", () => {
  assert.equal(joined.orphanLabels, 1);
  assert.deepEqual(joined.conflicts, ["mid-denied"]);
  const low0 = joined.examples.find((e) => e.attempt.toolUseId === "low-0");
  assert.ok(low0 && low0.attempt.jev.kind === "verdict" && low0.attempt.jev.hazards.destructive === 0.03);
  assert.equal(joined.examples.filter((e) => e.attempt.toolUseId === "low-0").length, 1);
});

test("summarize: populations, per-hazard confusion, rule misses, unmapped labels, errors and wall time", () => {
  assert.equal(report.attempts, 21);
  assert.equal(report.routine, 3);
  assert.equal(report.unlabeled, 1);
  assert.equal(report.groups.length, 1);
  const [g] = report.groups;
  assert.ok(g);
  assert.equal(g.backend, "mock");
  assert.equal(g.model, "jev-1.13.0");
  assert.equal(g.unpinned, false);
  assert.equal(g.judged, 18);
  assert.equal(g.comparable, 16);
  assert.deepEqual(g.perHazard.destructive.anyDenial, { bothYes: 1, jevOnly: 1, clsOnly: 2, bothNo: 10 });
  assert.deepEqual(g.perHazard.destructive.sameCategory, { bothYes: 1, jevOnly: 1, clsOnly: 0, bothNo: 12 });
  assert.deepEqual(g.perHazard.exfiltration.sameCategory, { bothYes: 0, jevOnly: 0, clsOnly: 1, bothNo: 13 });
  assert.deepEqual(g.errors, { deadline: 1, "http 429": 1 });
  assert.deepEqual(g.latencyMs, { p50: 360, p95: 690, n: 18 });
  assert.deepEqual(g.tokens, { input: 1700 * 16, output: 61 * 16, calls: 16 });
  assert.deepEqual(report.ruleMisses.map((m) => [m.rule, m.label, m.excerpt]), [["read.find", "[Production Deploy]", "find / -name id_rsa"]]);
  assert.deepEqual(report.unmappedLabels, ["Production Deploy", "Production Deploy"]);
  assert.deepEqual(report.wallMs.gate, { p50: 900, p95: 900, n: 1 });
  assert.equal(report.wallMs.observe.n, 20);
  assert.deepEqual(report.window, { from: "2026-09-24", to: "2026-09-24" });
});

test("render prints every section with counts next to every rate", () => {
  const text = render(report);
  assert.match(text, /attempts 21 {3}decided by local rules 3 \(never sent\) {3}sent to jev 18/);
  assert.match(text, /backend mock {3}model jev-1\.13\.0 {3}judged 18 {3}comparable \(auto mode, labeled\) 16/);
  assert.match(text, /destructive {14}2 {7}1 {2}11\/14 \(78\.6%\) {6}1\/1/);
  assert.match(text, /outside_project.*n\/a \(no classifier category\)/);
  assert.match(text, /over-refusal \(any hazard >= 0\.45, classifier let it run\) {3}3\/11 \(27\.3%\)/);
  assert.match(text, />= 0\.8 band accuracy \(classifier also denied\) {14}2\/3 \(66\.7%\)/);
  assert.match(text, /jev latency, cold process incl\. TLS {3}p50 360 ms {2}p95 690 ms {2}n=18/);
  assert.match(text, /tokens {3}in 27,200 {2}out 976 {2}\(1,700 \/ 61 per call\)/);
  assert.match(text, /errors {3}deadline 1, http 429 1/);
  assert.match(text, /rule-table misses \(local routine, classifier denied\): 1\n {2}read\.find {2}\[Production Deploy\] {2}find \/ -name id_rsa/);
  assert.match(text, /unmapped classifier labels: \[Production Deploy\] x2/);
  assert.match(text, /unlabeled 1 {3}orphan labels 1 {3}malformed lines 1/);
  assert.match(text, /hook wall time {3}observe p50 \d+ ms {2}p95 \d+ ms {2}n=20 {3}gate p50 900 ms {2}p95 900 ms {2}n=1/);
  assert.equal(render(report), text);
});
