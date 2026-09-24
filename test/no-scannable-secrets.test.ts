import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCAN = ["src", "test", "bin", "hooks", "docs", "README.md"];
const SKIP = new Set(["test/fixtures/leaks.jsonl"]);

// Provider token shapes that hosted secret scanners match on sight. Fake tokens in tests must be
// assembled at runtime ("AIza" + "...") so the repository never contains one whole.
const SCANNABLE = [
  /AIza[0-9A-Za-z_-]{30,}/, /npm_[A-Za-z0-9]{36}/, /ghp_[A-Za-z0-9]{36}/, /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/, /sk_live_[A-Za-z0-9]{10,}/, /glpat-[A-Za-z0-9_-]{20}/, /hf_[A-Za-z0-9]{30,}/,
  /AKIA[0-9A-Z]{16}/, /ASIA[0-9A-Z]{16}/, /xox[abp]-[A-Za-z0-9-]{10,}/, /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{40,}/,
];

function walk(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((name) => walk(join(path, name)));
}

test("no file in the repository contains a whole token a secret scanner would match", () => {
  for (const rel of SCAN.flatMap(walk)) {
    if (SKIP.has(rel) || rel.endsWith(".png")) continue;
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const re of SCANNABLE) assert.doesNotMatch(text, re, `${rel} contains a scannable token (${re.source})`);
  }
});
