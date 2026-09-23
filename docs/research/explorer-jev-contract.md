# Explorer 1: the Jev contract as a dependency

Sources: live docs (llms-full.txt, 20,737 lines), the OpenAPI spec (api.typesafe.ai/openapi.json v0.2.0), the @typesafe-ai/sdk 0.6.0 tarball, the typesafe-sdk-js repo, TypeSafe legal pages, jev-use repo, Vercel and OpenRouter gateway docs, eigent/flaviocopes/marktechpost articles. No live Jev calls (no key).

### Components found

- HTTP API. `POST https://api.typesafe.ai/v1/systemone` and `GET /v1/models`. Auth `Authorization: Bearer <key>`. Responses carry `x-typesafe-request-id`.
- Request (`SystemOneRequest`): `state` (string, object or array; SDK also allows null), `model` (required on the wire; SDK fills from `defaultModel`), `questions` (map name -> Question, at least one). Question ids are never sent to the model.
- Question types. `instructions` and criteria values can be string, object, array or null (`EntryType`).
  - `noul`: `{type:"noul", instructions?, criteria?: {true?, false?} | null}`.
  - `choice`: `{type:"choice", instructions?, criteria: {label: description | null}}`. Docs cap at 255; neither spec nor SDK enforces.
  - `score`: `{type:"score", instructions?, criteria: [level0, level1, ...]}`. Docs say 2 to 10 levels. Spec only `minItems: 1`. SDK checks >= 2.
- Answers.
  - `noul` returns `{type, noul}`, P(yes). **No `confidence` field.**
  - `choice` returns `{type, choice, probabilities: {label: p}, confidence}`.
  - `score` returns `{type, score, legend, probabilities: {"0": p, ...}, confidence}`. `score` is the probability-weighted mean of level indices. Keys are strings.
- Top-level: `{model, answers, usage: {input_tokens, output_tokens}}`. `model` is the versioned id, e.g. `jev-1.13.0`. No cost field.
- Errors: 401, 422 (FastAPI `detail` array), 429, 529. Undocumented 400 `Unknown model`.
- Limits (from /models page): 64k tokens per request (state plus all questions); 32k tokens for state plus the single longest question; 250,000 tokens/s and 1,200 requests/min, "can change without notice". **No documented cap on questions per call.** Text only.
- TS SDK `@typesafe-ai/sdk@0.6.0`. Published 2026-09-15, MIT, no deps, Node 20+, ESM and CJS.
  - Exports: `TypeSafeClient`, `choice`, `noul`, `score`, `ENV`, `VERSION`, `LOG_LEVELS`.
  - Errors: `TypeSafeError`, `APIError`, `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `UnprocessableEntityError`, `RateLimitError` (`retryAfterMs`), `InternalServerError`, `APIConnectionError`, `APITimeoutError` (`timeoutMs`), `APIUserAbortError`, `APIPromise`.
  - Main call: `client.systemOne<const Q>(request: SystemOneRequest<Q>, options?: RequestOptions): APIPromise<SystemOneResult<Q>>`. Answer types inferred per key; choice labels typed.
  - `TypeSafeClientConfig`: `apiKey` (env `TYPESAFE_API_KEY`), `baseURL` (env `TYPESAFE_BASE_URL`, default `https://api.typesafe.ai`), `defaultModel` (env `TYPESAFE_DEFAULT_MODEL`, default `jev-latest`), `logLevel` (env `TYPESAFE_LOG_LEVEL`, default `warn`), `logger`, `retry`, `timeout` (default 10000 ms **per attempt, no total budget**), `defaultHeaders`, `dangerouslyAllowBrowser`, `fetch`.
  - `RequestOptions`: `signal`, `timeout`, `retry`, `headers`.
  - `RetryPolicy` defaults: `maxRetries` 2, backoff 500 ms initial, 5000 max, jitter 0.25, statuses {408, 429, 500-599}, `respectRetryAfter` true, `maxRetryAfterMs` 60000, retries on connection and timeout errors.
  - The SDK does not validate responses at runtime and does not enforce the 255/10 limits.
- `baseURL` handling: SDK appends `/v1/systemone`.
  - OpenRouter: `baseURL: "https://openrouter.ai/api"`, bare ids remapped (`jev-1.13` -> `typesafe/jev-1.13`, `jev-latest` -> `~typesafe/jev-latest`). Also an alpha `POST /api/alpha/decisions` whose path "may move".
  - Vercel AI Gateway: `baseURL: "https://ai-gateway.vercel.sh/typesafe"`, model `typesafe-ai/jev`. Adds `provider_metadata.gateway` (cost). **Response `model` is `"typesafe-ai/jev"`, not versioned.** Errors as `{message, error_type}`. Vercel's `/v4/ai/evaluation-model` dialect renames `noul` to `boolean`, answer to `probability`, confidence into `providerMetadata`.
  - **No LiteLLM mention** in TypeSafe docs, SDK or gateway docs.

### Flow

SDK builds `{...request, model: request.model ?? defaultModel}`, validates (non-empty questions; score criteria >= 2), POSTs to `baseURL + /v1/systemone` under an AbortController timeout per attempt, retries with backoff or honors Retry-After up to 60 s, parses JSON.

Quickstart example, verbatim from `jev-1.13.0`:

```json
{"state":"Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
 "model":"jev-latest",
 "questions":{
  "department":{"type":"choice","instructions":"Which team should handle this","criteria":{"billing":"Payment or subscription issues","technical":"Bugs or integration problems","sales":"Pricing or account questions"}},
  "frustration":{"type":"score","instructions":"How frustrated the customer appears","criteria":["Calm, just stating facts","Frustrated but civil","Very angry, strong language"]},
  "is_urgent":{"type":"noul","instructions":"The message conveys urgency or time-sensitivity"}}}
```
```json
{"model":"jev-1.13.0",
 "answers":{
  "department":{"type":"choice","choice":"technical","confidence":0.78,"probabilities":{"technical":0.85,"sales":0.0,"billing":0.15}},
  "frustration":{"type":"score","score":1.0,"confidence":1.0,"legend":{"0":"Calm, just stating facts","1":"Frustrated but civil","2":"Very angry, strong language"},"probabilities":{"0":0.0,"1":1.0,"2":0.0}},
  "is_urgent":{"type":"noul","noul":1.0}},
 "usage":{"input_tokens":392,"output_tokens":65}}
```

Optional noul criteria: `"criteria":{"true":"...","false":"..."}`.

### Files read

Local: `/tmp/jev-research/llms-full.txt`, `/tmp/jev-research/package/dist/index.d.mts`, `index.mjs`, `package.json`, `/tmp/jev-research/typesafe-sdk-js/src/retry.ts`, `test/integration/api.integration.ts`, `/tmp/jev-research/skills/skills/typesafe-ai/SKILL.md`, `/tmp/jev-research/jev-use/bench/RESULTS.md`, `docs/evidence.md`, `docs/reference.md`, `src/backends/vercel.ts`, `/tmp/jev-research/web/*` (fetched pages: openapi.json, Vercel TypeSafe doc, OpenRouter model page and SDK guide and gate-tool-calls cookbook, eigent, flaviocopes, marktechpost, TypeSafe homepage, launch blog, legal pages).

URLs: docs.typesafe.ai/{api, models, confidence, primitives/*, concepts/*, model-jaggedness/jev-1.13, legal, sdk/*}, typesafe.ai/blog/introducing-system-one-models-and-jev, typesafe.ai/legal/*, vercel.com/docs/ai-gateway/sdks-and-apis/typesafe, openrouter.ai/docs/guides/community/typesafe-sdk, browser-use/jev-ultrafast docs/performance.md.

### Boundaries

The harness must supply: text-only `state` (JSON, filtered to what the question needs); atomic questions with caller-chosen ids; every threshold and composition rule; the model id (pin `jev-1.13.0` if thresholds are tuned); its own total time budget (SDK worst case with defaults is about 3 x 10 s plus backoff, or up to 60 s on Retry-After); credential redaction; a fallback when Jev is unreachable.

What comes back: probabilities and derived `confidence` for choice and score only. For noul the harness makes its own certainty measure, e.g. `2*|p-0.5|` (jev-use) or a two-sided band (docs' YES=0.8/NO=0.2). `usage` counts, no dollars. Versioned `model` id (except via Vercel).

### Non-obvious things

- **The `confidence` formula is not documented.** Current doc Choice examples match `(p_top - 1/n)/(1 - 1/n)`, confirmed by jev-use across 318 answers. MarkTechPost's launch-era example matches `1 - normalized entropy`. May have changed after launch. For Score with >2 levels, jev-use found no function of the distribution that reproduces the value.
- Calibration is claimed "across groups of predictions" only. TypeSafe: it "does not guarantee that an individual answer is correct".
- Docs advice: "start conservative, test with your own data, plot confidence against accuracy", scale thresholds with stakes. Examples use 0.5 floor, 0.85 to 0.9 for destructive actions, noul YES=0.8/NO=0.2.
- **TypeSafe's docs never recommend "shadow mode".** That comes from Flavio Copes and pi-jev-context.
- No structural invariants: `P(refund)` and `P(not refund)` summed to 1.19 in the docs' own example.
- Jaggedness page lists known weak spots: literal reading, counting and math, date comparison, indirection, large irrelevant state (context rot), adversarial content in state ("does not treat it as hostile by default", relevant to prompt injection in diffs and commands), generation.
- Output varies between runs: OpenRouter cookbook saw up to 0.08 movement on identical input; jev-use saw 447 of 454 repeat identically, with 20 escalation flags flipping at the threshold.
- Model ids: `jev-latest` and `jev-preview` both point to `jev-1.13.0`; aliases "can change without a change on your side". Docs also use `jev-1.13` and `jev`. Some cookbooks ran `jev-1.12`. `GET /v1/models` lists aliases only. **No deprecation or sunset policy published.**
- Direct API is early access behind a waitlist. Vercel's gateway has no waitlist.
- The agent skill links to `docs.typesafe.ai/migrating-to-v1.md`, which 404s.
- Data handling: not trained on customer input without consent (Privacy Policy; MCA 4.1). MCA grants a perpetual license to Customer Data "to derive and generate Telemetry" and "to monitor for fraud and abuse"; Telemetry, including "classifications", may be processed "without restriction" (4.3). No retention period stated; DPA says "as long as necessary". US hosted. ZDR on the direct API is enterprise only. Vercel offers ZDR via `providerOptions.gateway.zeroDataRetention` on Pro/Enterprise, in the AI SDK path; unverified on `/typesafe`. **MCA 2.3(b) bans using Output to "train a model to imitate the output of the Services"**, which matters if a harness logs verdicts to train a local replacement. SDK `logLevel: "debug"` logs request bodies unredacted (only credential headers masked). jev-use strips credentials before sending; that measurably changes verdicts (5 of 6 kept direction, a benign health check flipped deny to allow).

### Vendor-claimed vs independently measured

| Vendor says (TypeSafe) | Someone else measured |
|---|---|
| 70 to 500 ms, "most about 100 ms"; cookbooks 111 to 114 ms mean (US West Coast) | jev-use via Vercel gateway 2026-09-19: p50 223 / p95 364 ms single call; gate p50 252 ms; 454-judgment corpus p50 232 ms. browser-use: median 178 ms. |
| "193.6x faster, 444.6x cheaper" (own workflow evals vs average of GPT-6 Astra and Fable 5.1; "higher end of real world gains"); "40x to 200x faster" | jev-use vs properly configured baselines: **3.0 to 3.1x faster** than strict Haiku (225 vs 691 ms p50), **16x cheaper** ($0.018 vs $0.30 per 1k judgments). Unconfigured baselines look like 14x. Hook gate vs supervisor LLM: 510x cheaper per decision, 0.71 vs 1.98 s wall time. |
| $0.042/Mtok input, output free; "can't prove it isn't subsidized" | jev-use: Vercel gateway billed **$0** for Jev on its key. Price matches on OpenRouter and Vercel. |
| Batching 13 questions: 12.2x cheaper, 10x faster | jev-use: 12 questions, 224 ms batched vs 2,662 ms for 12 calls. pi-heed: 1, 4 or 8 questions per call all ~274 ms median. |
| Calibrated through RLCD, in aggregate | **No independent calibration study found.** jev-use's 8 clear vs 8 borderline test "did not separate": Jev answered decisively on borderline cases. Escalated verdicts right 51%, acted-on verdicts 87.5%. |
| "Can't hallucinate" / 0% type errors (structural) | Holds for shape. jev-use: one option never selected (0 for 13 on hold states); agreement with a claude-opus-5 reference 82.2% (89.5% non-escalated) vs 68.7% majority baseline. |
| "18x faster at p95 than GPT Luna" (Rauch, via MarkTechPost) | Not reproduced; second-hand. |

### Open questions

- Exact `confidence` formula, especially for Score, and whether it changed after launch.
- Any per-request question-count limit beyond 64k tokens.
- Whether `jev-1.12` still works; whether `jev-1.13` and `jev` are official ids.
- Retention period for inputs in logs and telemetry; non-enterprise ZDR.
- Whether Vercel ZDR applies on the `/typesafe` path; whether OpenRouter ZDR routing covers Jev.
- LiteLLM support: none documented.
- Latency outside the US West Coast. Every independent number came from one region and one day.
