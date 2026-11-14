# STAGE 1 — Understand the competition, design the architecture

Date: Sat 2026-11-14 ~09:40–10:00 WIB. Status: research + design only, NO implementation yet.
Workdir: `~/workspace/makefun/free-model-aggregator-01/` (competition.json, requirements.json,
rules-full.txt, kit/ unpacked, leaderboard.json, submissions.json).

## 1. Competition facts (verified live via curl, API key from ~/.makefun/credentials)

- Slug: `free-model-aggregator-01` — "The best free AI model aggregator". Harness: **agent/v1**.
- Status: open, `acceptingSubmissions: true`. Opened 2026-11-14T02:30:00Z.
- Deadline (entries close): **Sun 2026-11-16 09:30 WIB = 2026-11-16T02:30:00Z**.
- Reward: **$500 USDC on Solana, escrowed** (escrow GHeM65AzraMgbc1MapEUwnwB6hKTPBX671ktWRQR4yis,
  funded 500000000 base units, mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).
  Places: 1st $100, 2nd $70, 3rd $50, 4th–10th $20, 11th–20th $14. One place per entrant.
- Final phase: 2026-11-16 02:40–10:40Z. Every final entry runs scored instance 1 live once;
  the **top 60** (plus ties with 60th) run all 3 scored instances, each live then replayed;
  contenders rank on **mean score over the 3**. `practice_floor: 0` — every entry reaches the final.
  `model_calls: optional` — a pure-code server is a legal entry (no LLM calls of its own).
- Submissions: max 10/day, 20 total per entrant. Last submission before deadline is final.
- Field (corrected): the brief said "6 submissions" but the live list at ~09:55 WIB shows
  **50 submissions already** (all created 02:49–02:51Z, all score null — still grading/verifying).
  Dev leaderboard entries are empty (placements held). One rival title claims
  "practice 99/99/99" — near-perfect scores are achievable; the bar is high, not thin.
- Entry: public GitHub repo created after the competition opened, OSI license, entrypoint
  `main.ts` (Node 22) or `main.py` (Python 3.13) at repo root, `.makefun/owner.json`
  `{"wallet": "BghxTGURoYyWDjrUAnoBu5HWwRmnnoueR5PuDUfRb9gE"}`. Size caps: 8 MiB/file, 16 MiB/tree.
- Transcript gate (requirements): `thinking_reproduces` min 0.3 + ≥1 authored line in the entrypoint,
  `thinking_turns` ≥5 assistant turns with text, `thinking_revised` ≥2 file writes revising some file,
  `thinking_priced` (Muse app sessions: ≥1 usage row, attach with bundle `--muse-usage`),
  `thinking_in_window` (all timestamps inside competition window). Build stays in THIS session,
  staged one stage per message; `main.ts` is written in later stages, revised at least once.
  Model: muse-spark-1.3.

## 2. Kit structure (kit.tar.gz 6.3 MB, 37 files)

- `RULES.txt` (72 KB) — same rules as the API; `competition.yaml` (harness config, trials, limits).
- `cli/makefun.mjs` — grade-local / bundle / check / submit. `cli/known-sdk.json` — SDK release hashes.
- `gateway/` — model gateway (not needed: our server makes no LLM calls of its own).
- `harness/harness-src.tar.gz` — harness source (sha256 pinned in kit.json).
- `practice/trial-{0,1,2}/` — input (env/providers.json, env/workload.json, prompt.txt) +
  reference (catalog.json, ratings.json). Reference catalog/ratings are **identical across trials**;
  only budgets / fail_calls / outage / workload bodies vary (drand-drawn).
- `program/env/server.mjs` (1811 lines) — the trial env: providers, client, checks, state export.
- `program/generator/draw.mjs` (637 lines) — how instances are drawn (seeded, drand).
- `program/scorer/score.mjs` (552 lines) — the exact scorer. `rules/instance.yaml` — beacon/rounds.
- `sdk/makefun-agent.{ts,py}` — agent SDK for entries that call models (not needed here).
- `starter/` — house baseline server (`main.ts` + `lib/providers.ts` + `lib/wire.ts`) + MIT LICENSE.
  The starter says it is "worth roughly a quarter of the score" and lists its own gaps (see §5).

## 3. What the trial actually is (from rules + prompt.txt + env source)

- One server, two client APIs: `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages`
  (Anthropic), JSON + SSE streaming, plus `GET /v1/models` (wire chosen by auth header:
  `Authorization: Bearer` → OpenAI list, `x-api-key` → Anthropic list).
- Startup: read the brief at `$MAKEFUN_ENV_URL` is the env; brief at `$MAKEFUN_PROMPT_FILE`
  carries (a) provider directory, (b) sealed quality table, (c) workload manifest.
  Listen on a port you pick (never 8080), `POST $MAKEFUN_ENV_URL/register`
  `{"protocol_version": 1, "port": <port>, "catalog": <catalog>}` → `{"ok": true, "requests": 20}`.
  Poll `GET $MAKEFUN_ENV_URL/work` until `{"done": true}`, then **exit 0 immediately**.
  Trial wall: **180 s, 1 CPU, 2048 MB, 64 procs shared with the env**. A process still running
  at the wall scores **0 on every column**. Per-request client timeout: 30 s. Max response: 2 MB.
- The client sends the 20 requests **one at a time**, in manifest order r01–r20, and waits.
  Before the workload it warm-ups `GET /v1/models` twice (Bearer + x-api-key, 5 s timeout each).
- `node main.ts --list` prints the catalog document and exits 0 — byte-for-byte the same
  document as the register body. Outside a trial (no brief/env) it prints `{"providers":[]}`.
- Determinism: every choice must be a function of the brief, the requests and the providers'
  answers. No wall clock, no unseeded randomness (replay must leave a byte-identical state export).
  `MAKEFUN_TRIAL_SEED` is available if randomness is ever needed — the design uses none.

## 4. Providers, budgets, failures — the exact mechanics (env + generator source)

Ten providers, one per id, each with its own wire, auth, key, base path `/p/<id>`:

| provider | wire | auth | budget range | fail status | fail code | retry-after | notes |
|---|---|---|---|---|---|---|---|
| groq | openai | bearer | 9–12 | 429 | rate_limit_exceeded | yes | |
| cerebras | openai | bearer | 5–6 | 429 | too_many_requests | no | |
| gemini | gemini | x-goog-api-key | 6–8 | 429 | RESOURCE_EXHAUSTED | no | 1M ctx model |
| zai | anthropic | bearer | 4–5 | 429 | rate_limit_error | no | concurrency 1 |
| openrouter | openai | bearer | 10–12 | 429 | rate_limit_exceeded | yes | holds the only PAID model |
| sambanova | openai | bearer | 4–5 | 429 | insufficient_quota / queue_full | no | 2nd failure code |
| pollinations | openai | none | 10–14 | **402** | payment_required | no | the only 402 provider |
| cloudflare | openai | bearer | 7–8 | 429 | neurons_exhausted | no | |
| ovh | openai | none | 5–6 | 429 | rate_limit | no | |
| kilol | openai | none | 12–16 | 429 | rate_limit | no | |

- Per-trial draw (seeded): budget = int(min, max); fail count = 1–2 per provider;
  `fail_calls` = distinct call numbers drawn from **[2, budget−1]**; exactly one provider is
  designated so its fail_calls include **2**; exactly one (other or same) provider gets an
  outage with `outage_from` drawn from **[2, budget−1]**.
- Refusal order in the provider handler: wrong key → 401 (no budget spent); bad JSON → 400;
  unknown or **paid** model → 400 `invalid_model` (no budget spent); concurrent call on zai →
  429 `concurrent_requests` (no budget spent; hold is only 25 ms); then callNumber = calls+1:
  `callNumber > budget` → refuse; `outage_from` reached → refuse; `callNumber in fail_calls` →
  refuse. Refusals carry the provider's own status/code (+ `retry-after` header only for
  groq/openrouter) and **count toward budget**.
- **KEY THEOREM (proven from the draw + handler): the FIRST call to any provider always
  succeeds** (fail_calls ≥ 2, outage_from ≥ 2, budget ≥ 4) — given correct auth, a free model,
  and no concurrent zai overlap. A failover target that has never been called is a guaranteed
  success. Second calls are the risky ones.
- Catalog route (`GET <base>/v1/models`) is **free**: answered before any budget logic, never
  recorded, never counted. It lists every model with `free`, `context_length`, `tools`, `vision`,
  `json`. Probing all ten catalogs at startup costs nothing.
- Provider answers are synthetic: text is always `ANSWER ECHO{...}` (the provider echoes the
  fields it parsed), usage is a deterministic function of the request text lengths,
  stop is fixed per wire (`stop` / `end_turn` / `STOP`, all one family). **No tool calls are
  ever synthesized** — the response is pure text; the tool contract is satisfied via the echo.
  Streaming: OpenAI chunks / Anthropic message_* events / Gemini SSE, each with the same text
  split into pieces plus usage at the end (OpenAI usage chunk only if `stream_options.include_usage`).

## 5. The workload (fixed across trials; only bodies are re-seeded)

- r01–r02: openai, tools+vision, weight 2. r03: openai tools w2. r04–r05: anthropic tools w2.
  r06: openai vision w2. r07: openai json w1. r08–r09: anthropic json w1.
  r10–r12: min_context 200000 w1. r13–r20: no requirements w1 (r17/r18/r20 stream).
  Total weight 26 (12 from w2 + 14 from w1). 8 stream, 12 JSON.
- Best rating per request (sealed table): r01/r02/r06 → **1458** (gemini-3.8-flash, the only
  tools+vision model at the top; next is gemma-4-31b 1452, zai glm-4.6v 1432);
  every other request → **1475** (openrouter `z-ai/glm-5.3-flash:free`).
- Bodies: model `"auto"`; system prompt (some requests); user text with `[request nonce …]`;
  images as data-URL PNGs (r01/r02/r06); tools `lookup_customer` / `create_ticket`
  (OpenAI function shape vs Anthropic `{name, description, input_schema}` shape);
  `max_tokens`, `temperature`, `stop_sequences` (anthropic), `response_format: {type: json_object}`
  (r07 only — OpenAI wire). r10–r12 carry a long service log in the user text (min_context is
  about the MODEL's context_length ≥ 200000, not about truncating — pass the text through whole).
- Quality ceiling (trial-0 arithmetic): bound = 6×1458 + 20×1475 = 38248 milli-weight.
  Near-top supply (successful calls, trial-0): openrouter ≤10, zai ≤3, cloudflare ≤6,
  sambanova ≤3, gemini ≤5 → ~27 calls at rating ≥1458 for 20 requests. A perfect allocation
  can in principle reach quality ≈ 99–100; the binding constraints are per-provider budgets
  and the fail/outage draws, not total budget (72–84 calls for 20 requests).

## 6. How scoring works (scorer source — exact)

`score = round((60·quality + 15·served + 10·wire + 10·failover + 5·catalog) / 100)`,
each component `floor(100·x/y)`. Tie-break: fewer provider calls (`upstream_calls`), then earlier receipt.

- **quality (60%)**: Σ weight·min(rating, best) / Σ weight·best over the 20 requests, valid
  answers only. A paid-model answer earns nothing (the env marks it invalid — see below).
- **served (15%)**: floor(100 · valid / 20). Valid = ALL of the request's checks pass.
- **wire (10%)**: floor(100 · checks_passed / checks) over all requests' checks.
- **failover (10%)**: of requests whose FIRST provider call failed (402/429/5xx only),
  the share still served validly; 0 failover requests → 100 if anything valid, else 0.
- **catalog (5%)**: 42 checks — per provider (10): entry exists; base_url ends with the true
  path AND key_env matches; free-model id set exactly equals truth; no paid model marked free;
  plus 2 route checks (warm-up `/v1/models` with each auth header lists exactly the registered
  free ids). Note: the scorer never requires paid models to be listed — but list them with
  `free: false` anyway for a faithful catalog (they are known from the probe).
- The env's per-request checks (all must pass for `valid`): `http` (2xx), `shape`,
  `stream_order` (streaming only), `content` (whole ANSWER text present),
  `echo_system` / `echo_user` / `echo_tools` / `echo_max_tokens` / `echo_stop` / `echo_image` /
  `echo_json` (each only when the client sent that field — the provider must echo back exactly
  what the client sent, so the upstream request must carry every field through, translated
  losslessly), `stop_reason` (client stop family must equal provider stop family — always
  family 0, so answer `stop` on OpenAI / `end_turn` on Anthropic, even for tool requests),
  `usage` (input+output tokens must equal the provider's exactly; anthropic+stream compares
  output only), `free_model`, `one_provider` (**exactly ONE successful provider call per
  request — stop after the first success, never call a second provider to "verify"**),
  `requirements` (serving model meets the request's requirements per the sealed table).
- State export: the env writes `state.json`; `failures[]` holds at most the FIRST call (if it
  failed 402/429/5xx); `upstream_calls` counts EVERY recorded call in the request window —
  including 401/400/429-concurrent mistakes. Every wasted call hurts the tie-break, so never
  call with a wrong key, an unknown/paid model, or overlapping zai calls.
- `working` = 1 iff ≥1 request valid. Wall-timeout → 0 on every column.

## 7. Architecture design (to be implemented in Stages 2–4)

**Choice: Node 22, single-file `main.ts`, standard library only** (`node:http`, `node:fs`).
No dependencies, nothing installed. Rationale: matches the starter shape, grade-local
`--driver process` runs `node main.ts` directly, and Node's global `fetch` + HTTP server fit
the streaming passthrough. The starter's `lib/` split is NOT copied (unwritten copied lines
would sink the transcript `thinking_reproduces` share); the design is re-derived from the
kit's rules/env/scorer, and every line of `main.ts` is written in-session in later stages.

### 7.1 Startup / catalog (catalog 5% + warm-up route checks)
- Parse `$MAKEFUN_PROMPT_FILE`: directory (ids, wires, auth, key_env, paths, keys),
  quality table (ratings + tools/vision/json/context_length/free), manifest (order, api,
  stream, weight, requires). Parse `$MAKEFUN_ENV_URL`, `$MAKEFUN_TRIAL_SEED`.
- Build the catalog with ONE function used by both `--list` and register (byte-identical):
  probe each provider's `GET /v1/models` (free, in its own wire/auth) and merge with the
  brief — probe is ground truth for model lists, the brief's quality table confirms free
  flags/ratings/caps. Catalog entry: `{id, base_url: <path, e.g. /p/groq>, key_env, wire,
  models: [{id, free, context_length}]}` — free models `free: true`, paid models listed with
  `free: false`. Fallback per provider if a probe fails: brief quality table.
  `--list` with no brief → `{"providers":[]}`; with brief but no env → brief-only catalog.
- Listen on port 0 (ephemeral, never 8080) on 0.0.0.0, register protocol_version 1, then serve.
- `GET /v1/models`: auth header decides the shape; return `{data: [...]}` with each free id
  exactly once (OpenAI shape: `{object: "list", data: [{id, object: "model", ...}]}`;
  Anthropic shape: `{data: [{id, type: "model", ...}], has_more: false}`). No auth / unknown
  auth → OpenAI shape. Include `free: true` on items (the warm-up skips `free: false`).

### 7.2 Routing (quality 60% + served 15%)
- Candidate set per request: free models meeting `requires` (tools/vision/json/min_context)
  per the brief's quality table (= the sealed table). Rank by `rating_milli` desc.
- The manifest is fully known at startup (all 20 requests, weights, order), so plan the whole
  allocation up front instead of greedy per-request: weight-2 requests get first claim on the
  scarcest top models; weight-1 requests take near-top alternatives. Rating gaps at the top
  are tiny (1475 vs 1470 = 5 milli), so spreading across providers beats hammering one.
- Budget-aware adaptation (budgets are NOT in the brief — learn them by calling):
  track per-provider calls, successes, failures. On 402/429: mark the provider suspect and
  fail over to the next candidate; revisit the provider for a LATER request (a scheduled
  fail is transient — the next call may succeed; exhaustion/outage is permanent and the
  next attempt fails again, still recoverable via failover). Never retry the same provider
  twice inside one request. Prefer never-called providers as failover targets when ratings
  are close (their first call is guaranteed). For equal ratings, prefer the provider with
  fewer calls so far (deterministic tie-break: rating → calls-so-far → provider id).
- Hard filters, always: `free === true` only (never openrouter's paid opus-5.5, rating 1520 —
  the trap); model must meet requirements; JSON-mode OpenAI requests only to openai/gemini
  wires (an anthropic-wire provider echoes `json_mode: false` and would fail `echo_json`).
- Route by (provider, model) pair, not model id: the same id exists on several providers
  (glm-4.7-flash on zai+cloudflare, gpt-oss-120b on groq+cerebras, gemma-4-31b on
  gemini+sambanova, llama-3.3-70b on cloudflare+ovh).

### 7.3 The three wires (wire 10%)
- Upstream builders: OpenAI (`POST <env>/p/<id>/v1/chat/completions`, Bearer),
  Anthropic (`POST <env>/p/<id>/v1/messages`, Bearer or x-api-key per the provider's auth,
  `anthropic-version: 2023-06-01`), Gemini (`POST <env>/p/<id>/v1beta/models/<model>:
  generateContent` or `:streamGenerateContent`, `x-goog-api-key` or `?key=`).
  Auth comes from the brief's directory — the wire never decides the header.
- Lossless translation, both directions (the client compares the provider's echo with what
  it sent — any dropped/rewritten field loses the request):
  system, user text + images (OpenAI `image_url` ↔ Anthropic `image` base64/url ↔ Gemini
  `inlineData`/`fileData`), tools (OpenAI function ↔ Anthropic `{name, input_schema}` ↔
  Gemini `functionDeclarations`), `max_tokens` ↔ `maxOutputTokens`, stop ↔ `stop_sequences` /
  `stopSequences`, JSON mode (OpenAI `response_format` ↔ Gemini `responseMimeType:
  application/json`; never to an anthropic-wire provider), `temperature` passed through.
- Response translation: provider text returned **whole and verbatim** as the client wire's
  content; usage numbers copied exactly (OpenAI prompt/completion, Anthropic input/output,
  Gemini promptTokenCount/candidatesTokenCount); stop reason family 0 (`stop` / `end_turn`);
  streaming re-emitted in the client wire's event order (OpenAI chunks + `[DONE]` + usage
  chunk when `stream_options.include_usage`; Anthropic message_start → content_block_start →
  deltas → content_block_stop → message_delta → message_stop).
- Upstream streaming: set `stream_options: {include_usage: true}` on OpenAI-wire stream calls
  (otherwise no usage chunk arrives and the usage check fails); Gemini `:streamGenerateContent`
  with `?alt=sse` accepted.
- Sequential only: the client sends one request at a time; our server makes strictly one
  upstream call at a time (zai concurrency-1 safe, deterministic, no interleaving).
  Upstream timeout ~10 s via AbortController (client timeout is 30 s); a timeout counts as a
  failure and fails over. Never sleep on `retry-after` (fail over immediately — the wall is
  180 s and sleeps are not scored).

### 7.4 Failover (failover 10%) + exit discipline
- On 402/429/5xx/timeout: record the failure, try the next candidate in rating order.
  The request is already in the failover denominator once its first call fails — what matters
  is serving it validly afterwards. If all candidates are exhausted, retry the least-suspect
  provider once (its earlier failure may have been transient).
- Poll `GET /work` every ~100 ms; exit 0 the moment it says done. No other exit condition.
  Never block the poll loop on upstream work (requests are served on the HTTP server; the
  poller is independent).

### 7.5 Determinism
- No `Date.now()`, no `Math.random()` in any routing decision. All tie-breaks are fixed
  orderings. Polling timing never enters the state export. The same brief + provider answers
  ⇒ the same catalog, the same routing, the same state export on replay.

## 8. Main risks

- R1 Budget exhaustion on the top providers mid-trial (openrouter 10–12 for 17 requests that
  want 1475). Mitigation: §7.2 rotation + near-top alternatives (1470/1465/1458); validate by
  simulating trials 0–2 in Stage 4.
- R2 Unknown outage provider (one per trial, from call 2..budget−1). Mitigation: rotate on
  failure, never assume a provider is alive; never-called providers are guaranteed.
- R3 JSON-mode trap (r07-type): anthropic-wire providers cannot echo `json_mode`. Mitigation:
  wire filter in routing (§7.2).
- R4 `one_provider` check: a second successful call invalidates the request. Mitigation: stop
  after the first success, always.
- R5 Streaming usage: OpenAI upstream streams omit usage unless `include_usage` is set.
  Mitigation: always set it on stream calls.
- R6 Wall 180 s / exit-0: a hung poll or a retry-after sleep zeroes the trial. Mitigation:
  poll-and-exit discipline (§7.4), no sleeps.
- R7 Catalog byte-identity (`--list` vs register) + warm-up route checks. Mitigation: single
  `buildCatalog()` path (§7.1).
- R8 Paid-model trap: openrouter opus-5.5 (1520) is the highest rating in the table and is
  never legal. Mitigation: hard `free === true` filter, tested.
- R9 Overfitting trial-0: budgets/fails/outage are re-drawn per trial; the design must
  generalize (learn from answers, never hardcode trial-0 numbers).
- R10 Transcript gate: `main.ts` must be written + revised in-session across later stages
  (≥2 writes, ≥5 assistant turns, ≥30% authored share). This stage writes no code.

## 9. Stage plan

- Stage 2: write `main.ts` v1 — brief parsing, catalog probe + `--list`, server skeleton,
  OpenAI-wire upstream + client translation, rating-ordered routing v1. Grade-local trial-0.
- Stage 3: add Anthropic + Gemini upstream wires, streaming translation both wires, re-grade.
- Stage 4: budget-aware rotation + failover tuning; simulate on practice trials 0–2
  (grade-local + direct env replays); target practice ≥95, ideally 99.
- Stage 5: final review, bundle transcripts, `check`, submit (before Sun 2026-11-16 09:30 WIB).

## 10. Sources (all read this stage)

- `competition.json` + `requirements.json` (live API), `leaderboard.json`, `submissions.json`.
- Kit: `RULES.txt`, `competition.yaml`, `rules/instance.yaml`,
  `program/scorer/score.mjs`, `program/env/server.mjs`, `program/generator/draw.mjs`,
  `practice/trial-{0,1,2}/input/{env/providers.json, env/workload.json, prompt.txt}`,
  `practice/trial-0/reference/{catalog.json, ratings.json}`,
  `starter/main.ts` + `starter/lib/{providers,wire}.ts` (read, not copied).
- Skill: `~/workspace/makefun/skill.md` v1.5.99 (transcript gate, repo rules, submit pipeline).
