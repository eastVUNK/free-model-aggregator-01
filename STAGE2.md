# STAGE 2 — main.ts v1 + grade-local trial-0: score 99

Date: Sat 2026-11-14 ~10:30–11:00 WIB.
Repo: https://github.com/eastVUNK/free-model-aggregator-01 (this stage adds `main.ts`).

## What was built

Single-file Node 22 `main.ts` (~1400 lines, stdlib only: `node:http`, `node:fs`),
written from the Stage 1 design (the kit's starter was read, not copied):

- **Brief**: scans `$MAKEFUN_PROMPT_FILE` prose for the three JSON documents by `schema`
  (directory, quality table, manifest). **Catalog**: probes each provider's
  `GET /v1/models` in its own wire/auth (free, unrecorded), merged with the brief's
  quality table (sealed truth for free flags/context); one `buildCatalog()` used by
  both `--list` and register, byte for byte. Outside a trial `--list` prints
  `{"providers":[]}`.
- **Routing**: free models meeting the request's requirements, rating-ordered; on
  402/429 fail over to the next candidate, stop at the first success (exactly one
  successful upstream call per request); never-called providers preferred on rating
  ties (their first call is guaranteed); consecutive-failure state tracked per
  provider; one last-resort retry of the top candidate. JSON-mode OpenAI requests
  never route to an anthropic-wire provider. Paid models never routed.
- **Wires**: OpenAI / Anthropic / Gemini upstream builders + both client translators,
  lossless pass-through (system, user text + images, tools, max_tokens, stops,
  JSON mode, temperature; tool/stop order preserved). Responses: provider text
  verbatim, usage copied exactly, stop family 0 (`stop` / `end_turn`), streaming
  re-emitted in each wire's event order (OpenAI usage chunk via
  `stream_options.include_usage`; Anthropic input tokens in `message_start`,
  output in `message_delta`).
- **Server**: `GET /v1/models` by auth header, `POST /v1/chat/completions` +
  `POST /v1/messages`, requests serialized (one upstream call at a time; zai
  concurrency-1 safe). Register protocol_version 1, poll `GET /work` every 100 ms,
  exit 0 the moment it says done. No wall clock, no randomness in any decision.

## Grade-local trial-0 (driver process)

```
scores {"catalog":100,"failover":100,"quality":99,"score":99,"served":100,
        "upstream_calls":30,"wire":100,"working":1}
live_done: entry exited code 0 after 0.8 s
replay matched: state.json byte for byte
```

- 20/20 valid, 233/233 checks passed, failover 7/7, catalog route openai+anthropic true.
- Quality 99: lost 45 milli-weight of the 38248 bound (r04 −10, r13 −5, r16 −10,
  r17/r18/r19/r20 −5 each — all fell from openrouter 1475 to 1470/1465).
- 10 extra upstream calls, all starting with an openrouter 429: its call 2 and call 10
  are scheduled fails, and its budget (12) was spent after r15 — r16–r20 each wasted
  one call on the dead provider; r16 additionally hit zai's and cloudflare's scheduled
  call-2 fails before landing on sambanova 1465.

## What the score implies

- **Quality 99 is the trial-0 ceiling as an integer**: openrouter can only succeed
  10 times, but 17 requests want its 1475 model; the optimal allocation still loses
  35 milli-weight (7×1470), which also floors to 99. Our 45 lost is 10 over optimal.
- The rival claim "practice 99/99/99" is therefore the expected top score on trial-0,
  not a gap to close on quality — the differentiator is the **tie-break** (fewer
  upstream calls) and holding 99 across the other practice trials + the 3 fresh
  scored instances.
- No wire/catalog/served/failover work remains: all four are 100. The next revision
  is purely routing economy.

## Stage 3 (next revision)

1. **Dead-provider demotion**: a provider with ≥2 consecutive failures goes to the
   END of the candidate list (still tried before giving up). On trial-0 this saves
   ~3 wasted calls (r18–r20 stop trying dead openrouter) with zero quality cost.
2. Re-grade trials 0, 1, 2 (grade-local runs trial-0 only per call — run the kit env
   directly / repeat grade-local per trial to cover all three practice instances).
3. Verify `--list` vs register byte-identity inside a live trial env.
4. Then: final review, bundle transcripts, `check`, submit (deadline Sun 09:30 WIB).
