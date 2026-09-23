import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../src/", import.meta.url).pathname.replace(/\/dist\/test\/\.\.\/\.\.\/src\/$/, "/src/");
const MINTERS = new Set(["egress.ts", "hosts/claude.ts", "hosts/codex.ts", "cli.ts"]);

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), rel) : [rel];
  });
}

test("Raw text is minted only by egress, the host adapters, and readScripts", () => {
  for (const rel of walk(SRC)) {
    const text = readFileSync(join(SRC, rel), "utf8");
    if (rel !== "egress.ts") {
      assert.doesNotMatch(text, /\bas Raw\b/, `${rel} casts to Raw`);
      assert.doesNotMatch(text, /\bas Redacted\b/, `${rel} casts to Redacted`);
    }
    if (!MINTERS.has(rel)) assert.doesNotMatch(text, /\bfromHost\(/, `${rel} calls fromHost`);
  }
});
