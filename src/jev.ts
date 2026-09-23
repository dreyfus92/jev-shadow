/**
 * The Jev boundary. One function, `ask`, that never throws, never retries, and never outlives
 * its Deadline. Wire JSON (request and response) is private to this file; callers get a
 * `JevOutcome`.
 *
 * Why not @typesafe-ai/sdk: it would be the only runtime dependency, and every property we need
 * is one we'd have to switch off or re-do. It has no total budget (10 s per attempt, 2 retries,
 * Retry-After up to 60 s), it reads ambient env (TYPESAFE_BASE_URL can redirect the request,
 * TYPESAFE_LOG_LEVEL=debug logs request bodies unredacted, TYPESAFE_DEFAULT_MODEL defaults to
 * jev-latest), and it does not validate responses at runtime, so we'd parse them anyway. The
 * whole wire contract here is one POST with a fixed question pack. `fetch` plus an AbortSignal
 * covers it in Node 20 with zero dependencies.
 */
import type { JevState } from "./egress.js";
import type { Ms } from "./core.js";

// ------------------------------------------------------------------ the question pack

export const HAZARDS = ["destructive", "exfiltration", "remote_code", "weakens_security", "outside_project"] as const;
export type Hazard = (typeof HAZARDS)[number];

declare const pBrand: unique symbol;
/** A number in [0, 1]. Only `parseResponse` and config parsing construct one. */
export type Probability = number & { readonly [pBrand]: true };

/**
 * jev-axi's SAFETY_QUESTIONS (src/recipes/questions.ts:284-330), verbatim: five nouls plus a
 * three-level `risk` score. Verbatim keeps jev-axi's 44 labeled cases valid as a regression set.
 * The pack is a const, not config: changing it invalidates every logged verdict, so a change is
 * a version bump recorded in each log record (`pack`).
 */
export const PACK_VERSION = "axi-safety@2026-09-23" as const;
export declare const QUESTIONS: Readonly<Record<Hazard | "risk", WireQuestion>>;

/**
 * Pinned ids per backend. `jev-latest` and `jev-preview` are not representable. Vercel returns
 * an unversioned `typesafe-ai/jev` in responses, so drift there is undetectable; the report
 * groups by the response model and marks such groups "unpinned".
 */
export type PinnedModel = "jev-1.13.0" | "typesafe/jev-1.13" | "typesafe-ai/jev";

// ------------------------------------------------------------------ certainty for a noul

/**
 * Nouls return only P(yes). Our certainty derivation is the two-sided band from TypeSafe's docs:
 *   yes     p >= 0.8
 *   no      p <= 0.2
 *   unsure  otherwise
 * Chosen over jev-use's 2*|p-0.5| because every downstream consumer (the enforce policy and the
 * report) already thresholds at 0.8, and a band keeps "how sure" and "which way" as one value.
 * The report's band accuracy is the calibration check on this choice.
 */
export type Band = "yes" | "unsure" | "no";
export function band(p: Probability): Band {
  throw new Error("not implemented");
}

// ------------------------------------------------------------------ outcomes

export interface Verdict {
  readonly hazards: Readonly<Record<Hazard, Probability>>;
  /** Probability-weighted mean level of `risk`, in [0, 2]. */
  readonly risk: number;
  /** The `model` the response reported. Versioned on the direct API, not through Vercel. */
  readonly model: string;
  readonly usage: { readonly input: number; readonly output: number };
}

export type JevError =
  | { readonly kind: "no_key" }
  | { readonly kind: "deadline"; readonly budgetMs: Ms }
  /** TypeSafe's web firewall rejects bodies with literal attack commands. Kept distinct: it is signal. */
  | { readonly kind: "firewall" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "network"; readonly code: string }
  | { readonly kind: "malformed"; readonly at: string };

/** Latency is measured for failures too; a deadline hit is a latency data point. */
export type JevOutcome =
  | { readonly kind: "verdict"; readonly verdict: Verdict; readonly latencyMs: Ms }
  | { readonly kind: "failed"; readonly error: JevError; readonly latencyMs: Ms };

// ------------------------------------------------------------------ credentials

/** Opaque key. `toJSON` and `util.inspect` print "[secret]"; only `ask` calls `reveal`. */
export declare class Secret {
  private constructor();
  static of(value: string): Secret | null; // null for empty
  reveal(): string;
  toJSON(): "[secret]";
}

// ------------------------------------------------------------------ deadline

/**
 * One absolute instant per process, measured from process start (performance.timeOrigin),
 * not from the fetch, so Node startup, config, and stdin count against the budget.
 * `ask` requires one; a Jev call without a deadline cannot be written.
 */
export declare class Deadline {
  private constructor();
  static fromProcessStart(timeOrigin: number, budget: Ms): Deadline;
  /** AbortSignal.timeout(max(0, at - now)). Covers headers AND body: res.json() reads under it. */
  signal(now: number): AbortSignal;
  readonly budget: Ms;
}

// ------------------------------------------------------------------ backends

export type BackendId = "typesafe" | "vercel" | "openrouter" | "mock";

type Fetch = typeof globalThis.fetch;

/** A resolved backend. The four differ only in data; `ask` has one code path. */
export interface Backend {
  readonly id: BackendId;
  readonly url: string;
  readonly model: PinnedModel;
  readonly key: Secret | null; // null only for mock
  readonly fetch: Fetch;
}

/**
 * Endpoint table. URLs are constants, never read from env or from a repo, so nothing in a
 * cloned project can point the request somewhere else.
 */
export const ENDPOINTS: Readonly<Record<Exclude<BackendId, "mock">, { url: string; model: PinnedModel }>> = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  vercel: { url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", model: "typesafe-ai/jev" },
  openrouter: { url: "https://openrouter.ai/api/v1/systemone", model: "typesafe/jev-1.13" },
};

/**
 * Mock fixtures: first entry whose `match` is a substring of the serialized redacted state wins.
 * `delayMs` exercises the deadline; `status` exercises error paths; `body` is raw wire JSON so the
 * response parser runs in every test, not just against the network.
 */
export interface MockFixture {
  readonly name: string;
  readonly match: string;
  readonly delayMs?: number;
  readonly status?: number;
  readonly body: unknown;
}

/** A fetch that answers from fixtures and records each request body it received (leak tests read it). */
export function mockFetch(fixtures: readonly MockFixture[], seen?: string[]): Fetch {
  // TODO honor init.signal: reject with AbortError when it fires during delayMs
  throw new Error("not implemented");
}

/**
 * One POST, one attempt, under `deadline`. Never throws.
 *   no key                      -> failed no_key (no request made)
 *   AbortError from the signal  -> failed deadline
 *   403                         -> failed firewall
 *   other non-2xx               -> failed http
 *   fetch TypeError             -> failed network
 *   body fails parseResponse    -> failed malformed
 * The request body is built from `state` (already redacted) and QUESTIONS only.
 */
export async function ask(state: JevState, backend: Backend, deadline: Deadline, now: () => number): Promise<JevOutcome> {
  // TODO
  // const t0 = now()
  // if (!backend.key && backend.id !== "mock") return failed(no_key, 0)
  // try {
  //   const res = await backend.fetch(backend.url, { method: "POST", signal: deadline.signal(t0),
  //     headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key.reveal()}` } : {}) },
  //     body: JSON.stringify({ model: backend.model, state, questions: QUESTIONS }) })
  //   if (res.status === 403) return failed(firewall)
  //   if (!res.ok) return failed(http res.status)
  //   const parsed = parseResponse(await res.json())          // still under the same signal
  //   return parsed.ok ? verdict(parsed.value, now() - t0) : failed(malformed parsed.at)
  // } catch (e) { return failed(isAbort(e) ? deadline : network) }
  throw new Error("not implemented");
}

// ------------------------------------------------------------------ wire (private)

interface WireQuestion {
  readonly type: "noul" | "score";
  readonly instructions: string;
  readonly criteria?: unknown;
}

/**
 * Validates `{ model, answers: { <hazard>: { type: "noul", noul }, risk: { type: "score", score } },
 * usage: { input_tokens, output_tokens } }`. Every hazard present, every noul in [0,1], risk in
 * [0,2], usage non-negative integers. Extra keys ignored. Vercel's `{message, error_type}` error
 * body arrives with a non-2xx status and never reaches here.
 */
function parseResponse(body: unknown): { ok: true; value: Verdict } | { ok: false; at: string } {
  throw new Error("not implemented");
}
void parseResponse;
