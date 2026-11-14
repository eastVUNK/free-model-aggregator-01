# STAGE 3 — Dead-provider demotion + re-grade trials 0–2: 99 / 99 / 99

Date: Sat 2026-11-14 ~11:00–11:30 WIB.
Repo: https://github.com/eastVUNK/free-model-aggregator-01 (this stage revises `main.ts`).

## The revision (genuine main.ts change, second write of the file)

In `candidatesFor()` the candidate sort gained one key ahead of rating: a provider
with **≥2 consecutive failures is dead** and drops to the end of the candidate list,
whatever its rating. It is still tried before a request is given up, and a later
success revives it (`consecFails` resets to 0). Rationale, from the generator source:
a provider has at most 2 scheduled fail calls, so two consecutive failures mean
budget spent or outage far more often than an adjacent scheduled-fail pair — and
after the budget is spent every further call to it is a wasted tie-break call.

```ts
const dead = (c: Candidate): number => {
  const s = stats.get(c.provider.id);
  return s !== undefined && s.consecFails >= 2 ? 1 : 0;
};
// sort: dead asc, then rating desc, then stateClass, then calls, then id
```

## Method

The kit env was run directly (same setup grade-local's process driver uses:
`MAKEFUN_ENV_DATA_DIR` + `MAKEFUN_STATE_DIR`, then the sealed scorer on the
exported state) for all three practice trials, on v1 (demotion reverted) and v2.
The direct runner reproduces grade-local exactly (trial-0 v1: 99 / 30 calls, same
as the Stage 2 grade-local run). Runner: `run_trial.sh` in the workdir (kept
outside the repo).

## Results — before vs after

| trial | v1 score | v1 calls | v2 score | v2 calls | milli-weight lost v1 → v2 |
|---|---|---|---|---|---|
| 0 | 99 | 30 | 99 | **27** | 45 → 45 |
| 1 | 99 | 33 | 99 | **30** | 45 → 99 |
| 2 | 99 | 38 | 99 | **32** | 119 → 119 |
| total | | 101 | | **89** | |

All other columns 100 on every trial, both versions: served 20/20, wire 100,
failover 100 (v2: 5/5, 7/7, 8/8), catalog 100, working 1, replay byte-identical.
Every server exited 0 in ~1 s.

## Reading the numbers

- **Integer score 99 on all three practice trials, both versions.** Quality 99 is the
  ceiling as an integer: the top model (openrouter 1475) has only ~10 successes for
  17 requests that want it, so some loss is structural on every draw.
- **Demotion is a pure tie-break win: 12 fewer upstream calls across the three
  trials (101 → 89), same integer scores.** The tie-break (fewer calls, then
  earlier receipt) is the only differentiator left between 99-scoring entries.
- Honest caveat: on trial-1 v2 lost more milli-weight (99 vs 45) — the demotion
  shifted which providers the late requests fell to (r18 → ovh 1440, r19/r20 →
  gemini 1458 instead of cloudflare/zai 1470). It does not change the integer
  score (99.74 vs 99.88 both floor to 99), and the call saving is systematic
  while the milli-weight shift is draw-order luck. No further routing change is
  indicated: the remaining loss is provider supply + scheduled fails, not routing.
- **--list vs register byte-identical: YES** (checked in-trial: `node main.ts --list`
  against the live env, canonical JSON compared with the registered catalog in
  the trial's state export).

## Verdict

This is final on the routing side. No further tuning is worth the risk of
overfitting three practice draws: the scored instances are fresh draws, and the
design's guarantees (first-call success, dead-provider demotion, one successful
call per request, lossless wire translation) are draw-independent.

## Stage 4 (next)

Final review + sign-off: verify repo HEAD/tree vs local files, re-run grade-local
trial-0 once on the pushed HEAD, bundle transcripts, `check`, submit before
Sun 2026-11-16 09:30 WIB.
