import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "../src/log.js";
import { join, summarize, render } from "../src/report.js";
import { fixture } from "./helpers.js";

test("report over a fixture log: join, rates with counts, the ground-truth caveat", () => {
  const { records, malformed } = decode(fixture("log.sample.jsonl"));
  const report = summarize(join(records), malformed);
  const [group] = report.groups;
  assert.deepEqual(group?.overRefusal, { num: 3, den: 11 });
  assert.deepEqual(group?.highBandAccuracy, { num: 2, den: 3 });
  assert.equal(report.malformedLines, 1);
  assert.match(render(report).split("\n")[0] ?? "", /reference, not ground truth/);
});
