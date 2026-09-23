// Compiled by `tsc` in `npm test`, never run. Each @ts-expect-error fails the build if the line
// ever starts compiling, so "truncating unredacted text is unrepresentable" is checked by tsc.
import { clip, redact, fromHost, type Raw, type Redacted } from "../src/egress.js";

declare const raw: Raw;
declare const red: Redacted;

clip(redact(raw), 3000); // the one sanctioned order

// @ts-expect-error clipping raw text
clip(raw, 3000);
// @ts-expect-error truncating before redacting: slice() returns string, not Raw
redact(raw.slice(0, 3000));
// @ts-expect-error a plain string is not Raw; only host adapters call fromHost
redact("ghp_" + "x".repeat(36));
// @ts-expect-error concatenating redacted text yields string, not Redacted
clip(red + raw, 10);

void fromHost;
