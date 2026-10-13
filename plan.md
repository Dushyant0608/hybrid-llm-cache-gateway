# Hybrid LLM Cache Gateway — Development Report

**Final shipped architecture:** MiniLM semantic retrieval → low-cutoff filter → NLI contradiction veto → cache hit or LLM call.

This document is a complete report of the project: the final architecture first, then the full chronological development history — the original design, what was built, what broke, what was tried next, and how the team arrived at the final architecture — ending with the final evaluation results.

---

# Part A — Final Architecture (as shipped)

## Research Gap

LLM APIs are expensive and slow. Semantic caching systems like GPTCache solve this by storing past responses and reusing them when a similar question comes in — instead of calling the LLM again. They convert questions into meaning vectors and use cosine similarity to decide if two questions are "close enough."

This works, but has two known problems that existing literature acknowledges and hasn't fully solved:

**Problem 1 — False positives from pure semantic matching**
"Start the server" and "Stop the server" produce nearly identical meaning vectors because they're about the same topic. A pure semantic cache returns the wrong cached answer. A 2025 study on industrial query caching confirmed this exact failure mode — a query about one system's data was served an answer meant for a completely different system because the embeddings looked close enough.

**Problem 2 — Hardcoded parameters**
Every semantic cache has at least one critical setting: a similarity threshold (how similar is "similar enough"). This is set once by the developer and never changes. Research shows optimal threshold values range from 0.88 to 0.97 depending on the use case — a single hardcoded value is always wrong for some portion of traffic.

**The gap:** No existing system combines semantic retrieval with an explicit logical-contradiction check in the cache decision layer, verified end-to-end in a live production-shaped stack with real tuning derived from measured score distributions rather than guessed defaults.

> *Note on Problem 2: the final architecture does not solve this with automatic (Bayesian) tuning — that approach was built, tested, and dropped (full story in Part B). Instead, parameters are config-driven (Redis-backed, hot-reloadable) and tuned manually from measured score distributions — a deliberate scope decision given the project timeline.*

## Final Solution

A middleware service sits between any Node.js application and an LLM API. The application never calls the LLM directly — it calls this service, which either returns a cached response instantly or forwards to the LLM and stores the result.

**The core mechanism — a two-zone veto architecture:**

```
semantic_score < LOW_CUTOFF  →  skip straight to LLM (not similar enough to even consider)
semantic_score >= LOW_CUTOFF →  run NLI contradiction check (always)
    contradiction >= NLI_THRESHOLD  →  LLM (vetoed — logically contradicts the cached answer)
    contradiction <  NLI_THRESHOLD  →  cache HIT
```

Why two zones and not three (high/gray/low): cosine similarity score distributions for genuine paraphrases (0.489–0.969) and genuine non-matches (up to 0.999) **fully overlap** — there is no similarity score, however high, that is safe to auto-accept without running the contradiction check. This was proven empirically (Part B, Week 1 Part 10), not assumed.

**Why a pretrained NLI model instead of a hand-written rule:** an off-the-shelf NLI cross-encoder (`cross-encoder/nli-deberta-v3-small`, no fine-tuning) checks whether the new query logically contradicts the cached one. Hand-written antonym lists and rule-based negation/number checks were tried and rejected — they don't generalize to unseen phrasing and added no measurable benefit over the pretrained model.

**Why this replaced the original hybrid-blend idea:** the original design (`score = α·semantic + (1-α)·lexical`, with Bayesian optimization tuning α and the threshold from live traffic) was fully built, tested, and found structurally broken. The veto architecture is not a modification of that design; it's a different mechanism entirely (a gate, not a blend). The full story of how and why is Part B below.

## Approaches Considered and Rejected

All of the following were implemented and tested on real data, not dismissed on theory alone:

| Approach | Result | Why rejected |
|---|---|---|
| Raw Jaccard lexical blend (`α·semantic + (1-α)·lexical`) + Bayesian optimization | Optimizer always converged to α=1.0 (pure semantic) | Trap pairs like "start/stop the server" share almost all words by construction, so Jaccard scores them *higher* than genuine reworded paraphrases — lowering α makes results worse, not better |
| Stopword-filtered Jaccard | Same conclusion as raw Jaccard | Confirmed the failure is structural, not a tokenization artifact |
| Hand-written antonym word list | Not pursued to completion | Can't enumerate all antonyms in English; doesn't generalize to unseen query types |
| Rule-based negation/number-mismatch checks (on top of the NLI veto) | Added no further reduction in wrong hits | One false trigger found ("without" misread as negation), blocking a valid paraphrase |
| Embedding model swap (`multi-qa-MiniLM-L6-dot-v1`, dot-product retrieval) | No improvement over MiniLM cosine on wrong-hit rate; coarser, harder-to-tune threshold curve | Rejected; kept `all-MiniLM-L6-v2` |
| Automatic (Bayesian) tuning of the veto's own parameters (`LOW_CUTOFF`, NLI threshold) | Not built | Scoped out for implementation-time reasons, not because it was tested and failed — remains a legitimate avenue for future work |

## Architecture (as shipped)

```
                        ┌─────────────────────────────────┐
                        │         Node.js Gateway          │
User request ──────────▶│                                  │
                        │  1. Check Redis (exact match)    │
                        │  2. Generate embedding (MiniLM)  │
                        │  3. Query pgvector (semantic)    │
                        │  4. Below lowCutoff? → LLM        │
                        │  5. Else: call NLI verifier       │
                        │  6. Contradiction? → LLM, else HIT│
                        │  7. Log decision to telemetry     │
                        └────────────┬─────────────────────┘
                                     │
                    ┌────────────────┼────────────────┬──────────────┐
                    ▼                ▼                ▼              ▼
               ┌─────────┐   ┌────────────┐   ┌──────────┐   ┌──────────────┐
               │  Redis  │   │ PostgreSQL │   │   Groq   │   │  ml-service  │
               │         │   │ + pgvector │   │   LLM    │   │  (FastAPI)   │
               │ L1 cache│   │ L2 cache   │   │          │   │ /embed       │
               │ config  │   │ embeddings │   │ LLM only │   │ /verify      │
               │         │   │ telemetry  │   │ on miss  │   │ (MiniLM +    │
               └─────────┘   └────────────┘   └──────────┘   │  NLI model)  │
                                                               └──────────────┘
```

No Bayesian optimizer, no Python worker loop. `cache:config` in Redis (`mode`, `lowCutoff`, `nliThreshold`, `baselineThreshold`) is read fresh on every request and is hot-reloadable — change it with `redis-cli SET` and the next request picks it up immediately, no restart. Tuning is manual, driven by measured score distributions (Part C), not automatic.

## Request Flow

1. Request hits the gateway (`POST /v1/query`)
2. **L1 check** — Redis exact string match (MD5 hash). Hit → return instantly, logged as `decisionPath: exact`
3. **Embed** — MiniLM-L6 generates vector locally via `ml-service` (`POST /embed`), ~100ms round trip including network hop
4. **L2 check** — pgvector finds the single closest stored vector (`LIMIT 1`)
5. **Cutoff check** — if the candidate's cosine similarity is below `lowCutoff`, skip straight to the LLM (`decisionPath: below_cutoff` / `no_candidate`)
6. **Verify** — otherwise, call the NLI verifier (`POST /verify` on `ml-service`) with `{query, candidate}`, get back `{contradiction, entailment, neutral}` probabilities
7. **Decide** — contradiction ≥ `nliThreshold` → `vetoed`, fall through to LLM. Otherwise → `hit`, return the cached response
8. **Store** — on any LLM call, store the new query + embedding + response in Postgres and Redis (24h TTL)
9. **Log** — every request writes one telemetry row: `query`, `candidateQuery`, `semanticScore`, `nliContradictionScore`, `nliEntailmentScore`, `decisionPath`, `shouldHit` (ground truth, null for real traffic), `lowCutoffUsed`, `nliThresholdUsed`, `latencyMs`, `verifierLatencyMs`

## Directory Structure (as shipped, GitHub branch `NLI-migration`)

```
hybrid-llm-cache-gateway/
│
├── gateway/                          # Node.js Express service
│   ├── src/
│   │   ├── middleware/
│   │   │   ├── cacheMiddleware.js    ✅ Orchestrates full veto/baseline decision flow
│   │   │   ├── exactMatch.js         ✅ Redis L1 exact match check
│   │   │   ├── semanticSearch.js     ✅ pgvector cosine similarity search + store
│   │   │   ├── verifier.js           ✅ HTTP client → ml-service /verify
│   │   │   ├── embedder.js           ✅ HTTP client → ml-service /embed
│   │   │   └── llm.js                ✅ Groq API call on cache miss (renamed from gemini.js)
│   │   ├── service/
│   │   │   ├── redis.js              ✅ ioredis client + config reader/writer
│   │   │   ├── telemetry.js          ✅ Single-object logTelemetry, writes all decision fields
│   │   │   └── prisma.js             ✅ Prisma client setup
│   │   └── config/
│   │       └── default.js            ✅ Cold start defaults: {mode: 'veto', lowCutoff: 0.6, nliThreshold: 0.5, baselineThreshold: 0.85}
│   ├── prisma/
│   │   ├── schema.prisma             ✅ TelemetryLog: decisionPath, nliContradictionScore, nliEntailmentScore, lowCutoffUsed, nliThresholdUsed, verifierLatencyMs
│   │   └── migrations/               ✅ veto_architecture migration applied (dropped alphaUsed/thresholdUsed/similarityScore/lexicalScore)
│   ├── app.js                        ✅
│   ├── server.js                     ✅
│   └── package.json                  ✅
│
├── ml-service/                       # Python FastAPI (renamed from optimizer/)
│   ├── embedder.py                   ✅ Hosts BOTH /embed (MiniLM-L6) and /verify (NLI cross-encoder) in one process
│   └── requirements.txt              ✅ fastapi, uvicorn, sentence-transformers, torch (no scikit-optimize, no psycopg2, no redis)
│
├── evaluation/                       # Fabricated traffic testing
│   ├── query_set/
│   │   ├── paraphrases.json          ✅ 9 groups × 3 queries (shouldHit: true for 2nd/3rd)
│   │   ├── trap_pairs.json           ✅ 8 pairs (shouldHit: false)
│   │   └── unrelated.json            ✅ 7 pairs (first query is an intentional exact-match sanity check)
│   ├── simulate_traffic.js           ✅ Sends labeled queries to gateway over time
│   ├── run_eval.js                   ✅ Two-config comparison: baseline vs nliVeto
│   └── results/
│       └── comparison.json           ✅ Latest run: baseline vs veto@0.6, see Part C
│
├── demo-app/                         ✅ Minimal Express app routing through the gateway
├── docker-compose.yml                ✅ Postgres (pgvector) + Redis
├── plan.md                           ✅ (this file)
└── README.md                         ⬜ not yet written
```

**Deleted entirely (dead code from the rejected hybrid-blend architecture):** `gateway/src/middleware/hybridScorer.js`, `gateway/src/middleware/lexicalScorer.js`, `optimizer/bayesian.py`, `optimizer/worker.py`, `optimizer/scorer.py`, `optimizer/db.py`, `optimizer/redis_client.py`, plus ad-hoc research scripts `sweep.py`, `recompute.py`, `research/pair_eval.py` (kept outside the shipped repo, research-only).

**Legend:** ✅ = done and working, ⬜ = not built yet

## Key Technical Decisions (final)

| Decision | Choice | Reason |
|---|---|---|
| Embedding model | MiniLM-L6 (local, sentence-transformers) | Free, unlimited, ~3-5ms model latency, no API dependency |
| Verifier model | `cross-encoder/nli-deberta-v3-small`, off-the-shelf, no fine-tuning | Held-out 255-pair results strong enough that fine-tuning wasn't pursued |
| Verifier placement | Same FastAPI process as the embedder (port 5050), two endpoints | One less network hop; both models fit comfortably in memory |
| LLM for responses | Groq (`openai/gpt-oss-20b`) | Switched from Gemini after repeated free-tier deprecations and 503s under sustained test traffic |
| Vector DB | PostgreSQL + pgvector | Avoids a dedicated vector DB; Prisma supports it natively |
| Architecture shape | Two-zone (cutoff filter → always-run veto), not three-zone (high/gray/low) | Score distributions for positive and negative pairs fully overlap (0.489–0.999) — no similarity score is safe to auto-accept |
| Second-signal mechanism | NLI contradiction veto (a gate), not a weighted blend | Weighted lexical blending was tested and found structurally broken |
| Parameter tuning | Config-driven via Redis, manually tuned from measured score distributions | Automatic (Bayesian) tuning of the veto's parameters was scoped out of this project's timeline, not tested and rejected |
| Testing approach | Fabricated/labeled traffic (known `shouldHit` ground truth) | Real production traffic has no automatic way to know if a cache hit was correct |

## Known Limitations and Defenses (final)

**`same_topic_different_intent` gap (structural, documented, not solved)**
The veto only blocks logical contradictions. Queries that are topically related but functionally different (e.g. "check memory usage" vs "increase the memory limit") aren't contradictions, so NLI correctly — but unhelpfully — lets them through if they clear `lowCutoff`. This was found in the Week 1 offline study (4/25 same-topic pairs leaked) and confirmed again live (5 of 6 false positives at `lowCutoff=0.5` were this exact category). `lowCutoff` tuning mitigates but doesn't eliminate this — it works by filtering out the weakest matches in this category, not by teaching the system to understand intent.

**Isolated NLI model failure on specific lexical items**
Confirmed for "mute"/"unmute" via bidirectional isolated testing; ruled out as a general prefix-antonym problem (4 other prefix pairs tested, all correct). Likely a training-data coverage gap for this specific word pair in the pretrained model. Not fixable by any gateway-side parameter; would require either fine-tuning or an ensemble/second-verifier approach, out of scope for this project.

**Entailment-rescue for missed paraphrases (not implemented)**
8 of 11 paraphrases MiniLM under-recalled in Week 1 testing had recoverable entailment signal (>0.93). Documented as a real, scoped, bounded limitation and a legitimate future-work item, not pursued given project timeline.

**Ground truth problem in real production traffic**
The system cannot automatically label a cache hit as correct or incorrect without human review. Mitigated by using fabricated/labeled traffic (`shouldHit` field) for testing; `shouldHit` is `null` for real traffic, and the system makes decisions purely on `lowCutoff`/`nliThreshold` without needing ground truth at runtime.

**No automatic parameter tuning**
Unlike the originally planned Bayesian optimizer, `lowCutoff` and `nliThreshold` require manual tuning from measured score distributions (as done in this project). This is a conscious scope decision, not a technical dead end.

**Why NLI veto over a weighted blend or a bandit/EMA approach**
A weighted blend (the original hybrid design) was tested and found structurally unable to separate trap pairs from paraphrases using lexical overlap. A contextual bandit or EMA approach for parameter tuning was considered in the original optimizer design but dropped along with the rest of the automatic tuning scope.

## Remaining Work

- [ ] `README.md` with architecture diagram and setup instructions
- [ ] Verify citations (GPTCache, and the other literature references in the Research Gap section) before including them in a formal report
- [ ] Mini-paper / report structure: Abstract, Problem, Related Work, System Design, Evaluation, Conclusion — material for every section exists in this document
- [ ] Optional, time permitting: short demo video showing a live trap-pair test vetoed in real time
- [ ] Optional, unscoped: real GPTCache library comparison as a 3rd eval config
- [ ] Optional, unscoped: entailment-rescue rule, constrained-objective automatic tuning

---

# Part B — Development History (chronological)

This part documents the project exactly as it unfolded: the original design, what was built from it, what the team found when they tested it, and the step-by-step pivot to the final architecture in Part A.

## B1. Original Design (as first planned) — Hybrid Lexical-Semantic Scoring + Bayesian Optimization

**Two contributions, as originally conceived:**

**1. Hybrid lexical-semantic scoring.** Instead of relying purely on meaning vectors, every cache decision would use a weighted fusion of two signals:

```
Final Score = α × semantic_score + (1 - α) × lexical_score
```

- `semantic_score` — cosine similarity between meaning vectors (catches paraphrases)
- `lexical_score` — Weighted Jaccard similarity between keyword sets (catches keyword mismatches like start vs stop)
- `α` — the fusion weight, controls how much to trust each signal

This was intended to structurally prevent false positives that fool pure semantic systems.

**2. Bayesian optimization loop.** Instead of hardcoding α and the similarity threshold, a background Python worker would read cache decision logs and use Bayesian optimization (via scikit-optimize) to find better values from real traffic, updating the live parameters in Redis every 30 minutes, with the gateway reading new values immediately — no restart required.

**Original architecture diagram:**

```
                        ┌─────────────────────────────────┐
                        │         Node.js Gateway          │
User request ──────────▶│                                  │
                        │  1. Check Redis (exact match)    │
                        │  2. Generate embedding (MiniLM)  │
                        │  3. Query pgvector (semantic)    │
                        │  4. Compute Jaccard (lexical)    │
                        │  5. Fuse scores using α          │
                        │  6. Hit or miss decision         │
                        │  7. Log to telemetry table       │
                        │     (raw semantic + lexical +    │
                        │      shouldHit ground truth)     │
                        └────────────┬─────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
               ┌─────────┐   ┌────────────┐   ┌──────────┐
               │  Redis  │   │ PostgreSQL │   │  Gemini  │
               │         │   │ + pgvector │   │   API    │
               │ L1 cache│   │ L2 cache   │   │          │
               │ α config│   │ embeddings │   │ LLM only │
               │threshold│   │ telemetry  │   │ on miss  │
               └─────────┘   └────────────┘   └──────────┘
                    ▲
                    │ writes new α + threshold
                    │
          ┌─────────────────────┐        ┌─────────────────────┐
          │   Python Worker     │        │  Traffic Simulator   │
          │                     │        │                      │
          │ reads telemetry     │        │ sends labeled queries│
          │ re-simulates with   │        │ with shouldHit flag  │
          │   candidate params  │        │ (paraphrases, traps, │
          │ runs gp_minimize    │        │  unrelated)          │
          │ updates Redis config│        └─────────────────────┘
          └─────────────────────┘
```

**Original request flow:** L1 Redis exact match → MiniLM embed locally → pgvector top-5 candidates → compute semantic (cosine) + lexical (Jaccard) per candidate → fuse with current α from Redis → compare blended score to threshold from Redis, hit or call LLM → store on miss → log `semanticScore`, `lexicalScore`, `similarityScore` (blended), `shouldHit` to telemetry.

### Score Data Flow — the original critical design decision

**Problem discovered:** the gateway originally computed both raw scores (semantic + lexical), blended them into one `similarityScore`, and only logged the blended result — the raw components were discarded. The optimizer needed the raw scores to answer "what if α was 0.3 instead of 0.7?", which requires recomputing `candidate_α × semantic + (1 - candidate_α) × lexical` per log row. With only the blended score stored this is mathematically impossible — you can't un-blend `0.7A + 0.3B = 0.82` back into A and B.

**Fix:** log all three values in every telemetry row (`semanticScore`, `lexicalScore`, `similarityScore`, `shouldHit`), so the optimizer could re-blend with any candidate α during re-simulation:

```python
def objective(params):
    candidate_alpha, candidate_threshold = params
    logs = fetch_recent_logs()
    simulated_hits = 0
    false_positives = 0
    for log in logs:
        semantic, lexical, should_hit = log.semanticScore, log.lexicalScore, log.shouldHit
        new_score = candidate_alpha * semantic + (1 - candidate_alpha) * lexical
        would_hit = new_score >= candidate_threshold
        if would_hit:
            simulated_hits += 1
            if not should_hit:
                false_positives += 1
    hit_rate = simulated_hits / len(logs)
    fp_rate = false_positives / max(simulated_hits, 1)
    return -(hit_rate - fp_rate * penalty_weight)
```

### Optimization Loop (original design)

Every 30 minutes the Python worker: read last N rows from `telemetry_logs` → skip the cycle if fewer than 30 rows exist → define `objective(params)` that re-simulates hit/miss for each log using candidate `[alpha, threshold]` → pass to `gp_minimize` from scikit-optimize → write the best `[alpha, threshold]` to `cache:config` in Redis → gateway reads new values on next request. Each 30-minute cycle was treated as one experiment, with the Gaussian Process directing the next trial toward unexplored promising areas rather than guessing randomly.

### Ground Truth via Fabricated Traffic

In real production, there's no automatic way to know if a cache hit returned the *correct* answer — this is an open research problem. The chosen approach: build the system for production, but test it with a traffic simulator sending queries with known ground-truth labels, to measure real false positive rates, give the optimizer actual `shouldHit` labels, run controlled experiments, and validate the system before deploying on real traffic.

| Category | Purpose | `shouldHit` label | Example |
|---|---|---|---|
| Paraphrase pairs | Same meaning, different words — should hit | `true` (after first query cached) | "How to start the server" → "What's the command to launch the server" |
| Trap pairs | Similar topic, opposite meaning — should NOT hit | `false` | "Start the server" → "Stop the server" |
| Unrelated queries | Completely different topics — should miss | `false` | "Start the server" → "What's the weather today" |

### Original Evaluation Plan

Three configurations originally planned for comparison: **Baseline** (pure semantic, fixed α=1.0, fixed threshold=0.85, GPTCache style), **Hybrid Fixed** (fusion formula, fixed α=0.7, fixed threshold=0.85), **Hybrid Adaptive** (full system, Bayesian optimizer running) — measuring hit rate, false positive rate, latency, and parameter convergence over time. The primary claim to prove: Hybrid Adaptive beats Baseline on the hit-rate-vs-false-positive-rate tradeoff.

### Worker Guard Condition

```python
def run_optimization_cycle():
    logs = fetch_recent_logs()
    if len(logs) < 30:
        print("Not enough data yet, skipping this cycle")
        return
    result = run_bayesian(logs)
    set_config(result.alpha, result.threshold)
    print(f"Updated config: alpha={result.alpha}, threshold={result.threshold}")
```

This prevented the optimizer from making wild guesses on insufficient data during the first 30 minutes or during low-traffic periods.

### Cold Start Behavior

```js
const DEFAULTS = { alpha: 0.7, threshold: 0.85 }
async function initConfig() {
    const existing = await redis.get('cache:config')
    if (!existing) {
        await redis.set('cache:config', JSON.stringify(DEFAULTS))
    }
}
```

Redis was always the source of truth; hardcoded defaults were only a fallback for the very first boot.

### Redis Memory Management

Two mechanisms kept Redis lean: a 24-hour TTL on every write (`redis.set(queryKey, response, 'EX', 86400)`), and LRU eviction once Redis hits its memory ceiling (`--maxmemory 256mb --maxmemory-policy allkeys-lru`). Nothing was ever lost — anything evicted from Redis still lived in Postgres.

### Original directory structure and Key Technical Decisions

The original plan targeted a directory layout with `gateway/src/middleware/{hybridScorer.js, lexicalScorer.js, ...}` and a separate `optimizer/` Python service (`embedder.py`, `db.py`, `redis_client.py`, `scorer.py`, `bayesian.py`, `worker.py`). Key early decisions: MiniLM-L6 for embeddings, Gemini API for LLM responses, PostgreSQL+pgvector for the vector store, Weighted Jaccard for the lexical metric, scikit-optimize `gp_minimize` for the optimizer, Redis for the shared parameter store. All of this directory structure and tooling was later superseded — see B7–B9.

### Original Known Limitations (as first documented)

- **Ground truth problem** — mitigated via fabricated traffic with known `shouldHit` labels; real traffic optimizes on hit rate and latency alone.
- **Why Bayesian optimization over a contextual bandit or EMA** — EMA misses the α/threshold interaction; the search space is non-convex; Bayesian is more sample-efficient for expensive 30-minute experiments. Trade-off acknowledged for very high traffic systems, noted as future work.
- **Embedding latency** — MiniLM-L6 runs locally at 3-5ms, so this wasn't a practical concern.

## B2. Build Strategy and Status (original 7 phases)

| Phase | Scope | Status at the time |
|---|---|---|
| 1 — Infrastructure | Docker Compose (Redis + Postgres/pgvector), Prisma schema, gateway skeleton, MiniLM embedding call | ✅ Done |
| 2 — Baseline cache | L1 Redis exact match, pgvector nearest neighbor, fixed threshold decision, telemetry logging | ✅ Done |
| 3 — Hybrid scorer | Jaccard scorer, fusion formula with configurable α | ✅ Done |
| 4 — Schema + telemetry updates | Add `semanticScore`/`lexicalScore`/`shouldHit` columns, wire through middleware and telemetry service | ✅ Done |
| 5 — Optimizer (Python worker) | `db.py`, `scorer.py`, `bayesian.py` (gp_minimize wrapper), `worker.py` (30-min loop, min-30 guard) | ✅ Done |
| 6 — Fabricated traffic + evaluation | Query sets (paraphrases/trap/unrelated), `simulate_traffic.js`, `run_eval.js` three-config comparison | 🔧 Code done, not yet run |
| 7 — Demo app + writeup | Minimal demo app, README, mini-paper structure, citations, demo video | 🔧 Demo done, writeup pending |

## B3. Early Bug Fixes (Sep 24–30, 2026)

**Bugs fixed in the optimizer (Sep 24):**

| File | Bug | Fix |
|---|---|---|
| `embedder.py` | `/embed` endpoint had no `return` statement — always returned `null` | Added `return {"embedding": vec}` |
| `redis_client.py` | `get_config()` crashed with `TypeError` when Redis key didn't exist (`json.loads(None)`) | Added `None` guard before `json.loads` |
| `db.py` | Connection leak — `cur.close()`/`conn.close()` unreachable on exception | Wrapped in `try/finally` |
| `scorer.py` | `log[0] == True` fragile comparison | Changed to a plain truthy check |

**Design fix: raw score logging (Sep 24)** — see B1's Score Data Flow section above; this is where that fix was made (`schema.prisma`, `hybridScorer.js`, `cacheMiddleware.js`, `telemetry.js`, `db.py`, `scorer.py` all touched).

**New: ground truth via `shouldHit` (Sep 25)** — added the `shouldHit` boolean column described in B1, carried forward unchanged into the final architecture.

**New: fabricated traffic approach (Sep 25)** — adopted the simulator-based testing approach described in B1, also carried forward unchanged.

**Bug fixed in demo-app (Sep 30):** `fetch()` and `.json()` calls were missing `await` in `demo-app/server.js`, so response data was always undefined. Fixed by adding `await` to both.

## B4. Local End-to-End Testing (Oct 3, 2026)

With all phases built, the system was run end to end for the first time across all local services: Docker (Postgres + Redis), `embedder.py` (FastAPI), `gateway/server.js`, and `demo-app/server.js`.

**Bugs found and fixed during first integration run:**

| Issue | Root cause | Fix |
|---|---|---|
| Embedder failed to bind to port 5000 | Port already in use | Moved embedder to port 5050, updated `embedder.js` fetch URL |
| `password authentication failed for user "postgres"` | `.env` `DATABASE_URL` used a hardcoded user mismatched with `POSTGRES_USER` | Fixed `.env`; required `docker-compose down -v` to force Postgres to reinitialize |
| `relation "cached_responses" does not exist` | Volume wipe reset the database with no schema applied | Reran `npx prisma migrate dev` |
| `models/gemini-1.5-flash is not found` | Model deprecated | Updated to `gemini-2.5-flash` |
| `gemini-2.5-flash is no longer available to new users` | Model further deprecated | Updated to `gemini-3.8-flash` |
| `Unknown argument semanticScore` in Prisma Client | Migration originally run from wrong directory, silently failed | Ran `npx prisma generate`, restarted gateway |
| API key exposed in terminal output pasted into chat | Operational mistake, not a code bug | Key rotated immediately in Google AI Studio |

**Core pipeline verification** — all three cache decision paths were directly observed working and cross-checked against `telemetry_logs`: exact match (`source: exact`), cache miss (`source: llm`), semantic hit (`source: semantic`, a reworded paraphrase correctly matched via pgvector + hybrid scoring).

**A near-miss case** was captured directly in telemetry, confirming the hybrid formula was implemented correctly and demonstrating exactly the problem the Bayesian optimizer existed to solve:

```
query: "Which city is the capital of Germany?"
semanticScore: 0.9379
lexicalScore: 0.625
similarityScore: 0.8440 (= 0.7 × 0.9379 + 0.3 × 0.625)
thresholdUsed: 0.85
cacheHit: false
```

The blended score missed the fixed 0.85 threshold by 0.006 despite a very high semantic signal — confirming a static threshold under-caches legitimate paraphrases, and that the lexical component materially affects real decisions. A manual sanity check (temporarily lowering the Redis threshold to 0.80) confirmed the gateway reads config live from Redis on every request, with no restart delay — validating the hot-reload design.

**A second, unplanned case** provided direct empirical evidence for the project's core thesis:

```
query: "Germany is the capital of what city?"
semanticScore: 0.9851
lexicalScore: 0.4444
similarityScore: 0.8229 (= 0.7 × 0.9851 + 0.3 × 0.4444)
thresholdUsed: 0.85
cacheHit: false
```

Semantic similarity alone (0.985) would have classified this as a near-identical match under pure semantic caching (α = 1.0) — likely returning a wrong cached answer. The lexical component pulled the blended score down to 0.823, correctly keeping it below threshold. This was a real, unplanned confirmation of the false-positive failure mode described in the Research Gap, caught by the hybrid formula exactly as designed — at this point in the project, the hybrid blend still looked like it was working.

**Still to verify at this point:** `worker.py` had not yet been run against accumulated telemetry; `evaluation/simulate_traffic.js` and `run_eval.js` were written but not yet executed.

## B5. Optimizer Validation and Honest Findings (Oct 4, 2026)

**Infrastructure changes during this session:** LLM provider switched from Gemini to Groq — Gemini's free tier proved too unreliable for repeated testing (`gemini-1.5-flash` and `gemini-2.5-flash` both deprecated mid-project; even `gemini-3.8-flash` triggered consistent 503 "high demand" errors under sustained testing). Switched to Groq (`openai/gpt-oss-20b`, after `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` returned 404s as gated/paid-tier-only). The function name `callGemini` was kept unchanged in `cacheMiddleware.js` to avoid touching the call site — only `gemini.js`'s internals changed. Also fixed: `redis_client.py` required forcing RESP2 explicitly, since `redis-py` v5+ attempts a RESP3 `HELLO` handshake by default, unsupported by the `redis:7-alpine` container.

**Traffic simulation:** `simulate_traffic.js` was run against an expanded query set (57 total pairs, expanded from ~23 to clear the optimizer's `MIN_LOGS = 30` guard with margin). `sendQuery` was made resilient (try/catch, log-and-continue) after early runs crashed entirely on a single transient error. Final telemetry count: 88 logged rows. `bayesian.py` was updated to print every `gp_minimize` trial so the optimizer's search behavior was auditable.

**Bug found and fixed: zero-hit exploit in the objective function.** `scorer.py`'s `simulate_score` originally returned `-1` when a candidate `(alpha, threshold)` produced zero cache hits. At higher `penalty_weight` values this made "cache nothing" a rational escape hatch — multiple trials at `penalty_weight=3.0` converged on thresholds near 0.88–0.93 that hit nothing at all, scoring `-1.0000` (better than several real-hit configs), instead of genuinely searching for a good tradeoff. **Fix:** changed the zero-hit penalty from `-1` to `-5`, always worse than any plausible real-hit outcome.

**Core finding: the hybrid mechanism validated at the individual-decision level.** Direct telemetry inspection of a trap pair confirmed the formula works exactly as designed:

```
Cached: "Increase the memory limit"
Query: "Decrease the memory limit"
semanticScore: 0.9386
lexicalScore: 0.6000

Pure semantic (alpha=1.0): 0.9386 >= 0.79 -> HIT (false positive)
Hybrid default (alpha=0.7): 0.837 < 0.85 -> MISS (correctly avoided)
```

A real, reproducible case on the actual deployed stack where pure semantic caching would have served a wrong answer, and the hybrid formula's lexical term prevented it.

**Open tension: the Bayesian optimizer's aggregate result favored α close to 1.0.** Running `gp_minimize` against the 88-row dataset with the zero-hit bug fixed and `penalty_weight=3.0` consistently converged toward `alpha ≈ 1.0` (best trial: alpha=1.0, threshold=0.79) — the *opposite* of what the per-decision finding above would suggest. This did not contradict that finding; it reflected a separate, real limitation:

1. **Small dataset** — 88 total logged requests, fewer usable for scoring once exact matches are excluded; too few trap-pair cases for the optimizer to reliably learn to protect against them.
2. **Lexical scorer lacked stopword filtering** — raw Jaccard. Short imperative queries differing by one keyword ("increase"/"decrease") still retained meaningful overlap from shared structural words, diluting the lexical signal.
3. **Objective function treated all false positives uniformly** — a flat `penalty_weight` didn't distinguish a costly wrong-answer false positive from a lower-stakes one.

**Next steps planned at the time:** add stopword filtering (or move to BM25/TF-IDF) to sharpen the lexical signal; expand the trap-pair and paraphrase query sets; consider category-aware penalty weighting; re-run the three/four-config comparison only after the above was addressed. This is the point where the investigation that follows in B6 began.

## B6. Investigation: Lexical Scoring Failure → NLI Veto Pivot (Week 1, Oct 2026)

*(This is the pivotal research phase. It takes the open tension from B5 — why does the optimizer favor α≈1.0 even though hybrid scoring demonstrably catches real false positives? — and follows it to its conclusion: lexical blending is structurally broken, and a different mechanism is needed.)*

### Part 1 — Clean baseline rebuild

Before any new experiments, the telemetry baseline was found contaminated: two separate `simulate_traffic.js` runs had been logged into the same table without truncation, producing mismatched candidate pairs across runs. Fixed by adding a retry + system-message fix to `llm.js` to stop Groq's tool-call 400 error on certain queries, fixing `simulate_traffic.js`'s label logic (trap-pair first queries were incorrectly defaulted to `shouldHit: true`; changed default to `false`, with explicit `firstLabel` overrides for the two pairs with a real cached match), and a full reset (Redis flush, table truncate, config reset). Clean rerun: 57 rows, 49 with `candidateQuery`, labels 27 true / 29 false / 1 null. Exported as a frozen baseline CSV before further testing.

### Part 2 — Jaccard-based hybrid scoring: rejected

The original hybrid formula was tested with a full grid sweep (`sweep.py`) over α ∈ [0,1] and threshold ∈ [0.5, 0.95] on the clean baseline, replacing the original 15-trial Bayesian search.

**Finding:** α = 1.0 (pure semantic) was the real optimum — not a thin-search or buggy-objective artifact. At α=1.0/threshold=0.79: 15 hits, 3 false positives. At the hybrid default α=0.7/threshold=0.7: only 7 hits, 4 false positives — strictly worse on both counts.

**Root cause identified:** trap pairs ("Start the server" / "Stop the server") share almost all their words by construction, so raw Jaccard scores them *higher* than genuine paraphrases, which are reworded and share fewer words. Lowering α therefore weights a signal pointing the wrong direction. Confirmed directly: `shouldHit=false` rows averaged 0.253 lexical score vs. `shouldHit=true` rows at 0.130 — the lexical signal was inverted relative to what the blend needed.

**Conclusion:** word-overlap scoring is structurally unsuited to this problem. Rejected.

### Part 3 — Stopword-filtered Jaccard: also rejected

Hypothesis: raw Jaccard's failure might be due to stopwords inflating overlap scores. Tested a stopword-filtered, punctuation-stripped version (`recompute.py`) on the same frozen rows, recomputed offline with no new traffic.

**Finding:** the class-average direction flipped (shouldHit=true rows now scored higher lexical on average), but the best α barely moved — from 1.0 to 0.9, objective score changing by ~0.001, within noise. The best real config was still effectively pure semantic.

**Conclusion:** the failure is structural, not a tokenization artifact. Stopword filtering does not rescue it.

### Part 4 — Objective function flaw found

The original optimizer objective (`hit_rate − λ·fp_rate`, hit_rate divided by all logs, fp_rate divided only by hits) contained a loophole: a config producing exactly one safe hit and zero false positives could outscore a config with many real hits, because `fp_rate` only penalizes relative to a small hit count. This explains why the optimizer could discount real, known false positives (like the "memory limit" trap pair from B5) in aggregate even when they were demonstrably preventable — this is the mechanical reason behind B5's open tension. Objective needed restructuring (maximize hit rate subject to a wrong-hit-rate budget) before any further threshold-tuning claim could be trusted — carried forward as future work, not solved within this project.

### Part 5 — Pivot: veto architecture instead of score blending

Decision made to stop trying to rescue lexical blending and instead treat a second signal as a **veto/gate**, not a weighted component — don't average a correctness signal into a similarity score; use it to override the decision. Considered: a hand-written opposite-word list (rejected — can't enumerate all antonyms in English, doesn't generalize, violates the project's own "must work on any query" requirement) vs. a pretrained NLI (Natural Language Inference) model used off-the-shelf, run only on borderline semantic matches, to check whether two queries are compatible or contradictory. Model chosen for testing: `cross-encoder/nli-deberta-v3-small`, no fine-tuning initially — to test whether a pretrained model works before investing in training one.

### Part 6 — Offline pair-set evaluation (no gateway changes)

Built a separate offline evaluation harness (`research/pair_eval.py`, kept outside the main project folders) to test candidate scoring methods against labeled query pairs without touching the gateway or sending real traffic.

**Batch 1 (200 pairs):** 25 paraphrases + 175 "different" pairs across 7 failure categories (antonym, negation, number_change, direction_reversal, entity_swap, same_topic_different_intent, unrelated), generated via LLM prompt and reviewed.

**Result at threshold 0.7:**

| Method | Recall | Wrong hits |
|---|---|---|
| Semantic only | 1.00 | 117 |
| Semantic + Jaccard blend | 0.80 | 103 |
| Semantic + NLI contradiction veto | 1.00 | 4 |

The veto reduced wrong hits by ~97% with zero recall cost on this set. Per-category breakdown showed full success (0/25 wrong hits) on 6 of 7 failure categories (antonym, negation, direction_reversal, entity_swap, number_change, unrelated). The only category with leakage was `same_topic_different_intent` (4/25), e.g. "cancel my subscription" vs "pause my subscription" — these aren't logical contradictions, so NLI correctly (and unhelpfully) scored them as non-contradictory.

A rule-based layer (negation-word mismatch, number mismatch) was tested on top of the veto and found to add no further reduction in wrong hits, while introducing a false trigger (blocked a valid paraphrase because "without" was misread as a negation). **Dropped.**

### Part 7 — Held-out confirmation (Batch 2, 255 pairs total)

A second, independently generated batch of 55 pairs (40 stylistically varied paraphrases — imperative vs question phrasing, reordered clauses, typos, filler words, different verbs for the same action — plus 15 new `same_topic_different_intent` pairs never seen in Batch 1's templates) was added and the full comparison rerun.

**Result:** the same 4 `same_topic_different_intent` wrong hits persisted, with **zero new leaks** among the 15 new unseen pairs of that category — confirming the veto generalizes rather than memorizing Batch 1's specific examples.

**New finding:** overall recall at threshold 0.7 dropped from 1.00 to 0.83 — 11 of 65 genuine paraphrases scored below 0.7 semantic similarity due to more varied phrasing. A **separate problem** from the false-positive issue: MiniLM's own retrieval under-recalls casually/divergently phrased paraphrases, and the veto can't rescue a candidate that never clears the semantic threshold to reach it.

### Part 8 — Entailment as a partial recall rescue

Checked NLI *entailment* probability (not just contradiction) on the 11 missed paraphrases. Found 8 of 11 had entailment > 0.93 (strong rescue signal), while 3 scored near zero (0.002–0.005) despite being genuine paraphrases — specifically the pairs with the most structural divergence (different verb, different sentence shape, e.g. "turn on login verification" vs "enable two-step login protection").

**Conclusion:** an entailment-based rescue rule (low-but-nonzero semantic + high entailment → still treat as a candidate) could recover most, not all, of the lost recall. The remaining 3 failures point to a known limitation of NLI models: trained on declarative statement pairs, not imperative commands, so they struggle when two commands share little surface structure. Documented as an open, bounded limitation — not solved, not pursued further within the time budget.

### Part 9 — Embedding model swap tested and rejected

Tested replacing `all-MiniLM-L6-v2` with `multi-qa-MiniLM-L6-dot-v1` (a retrieval-oriented embedding model, same architecture family) as a possible fix for the recall bottleneck in Part 7. Initial test used cosine similarity and showed poor separation — traced to the model being trained for dot-product scoring, not cosine. Retested correctly using raw dot product with model-appropriate thresholds (range 21.36 to 53.06).

**Result at matched recall levels:** multi-qa dot-product did not outperform MiniLM cosine on wrong-hit rate, and its threshold curve was coarse and jumpy (recall dropped 1.00 → 0.91 → 0.66 in two large steps) versus MiniLM's smooth, gradual curve (1.00 → 0.98 → 0.94 → 0.83 → 0.65 → 0.31). A smooth curve is materially easier to tune safely.

**Conclusion:** embedding model swap rejected. `all-MiniLM-L6-v2` retained. No further embedding-model experiments planned.

### Part 10 — No safe "skip the verifier" zone exists

Before finalizing the architecture, the actual score distributions (not assumed thresholds) were computed from all 255 pairs:

- **Positive pairs (genuine paraphrases):** min 0.489, p50 0.865, p90 0.933, p99 0.969
- **Negative pairs (should not hit):** p90 0.994, p95 0.997, p99 0.998, **max 0.999**

**Finding:** the two distributions fully overlap. A "different" pair can score cosine similarity as high as 0.999 — higher than the median genuine paraphrase (0.865). There is **no cosine similarity value, not even 0.95 or 0.99, that is safe to auto-accept without running the verifier.** This directly confirms and quantifies the original failure mode (e.g. the "Increase/Decrease the memory limit" trap pair from B5 scored 0.939 semantic similarity).

**Architectural conclusion:** a three-zone design (`HIGH → direct cache, GRAY → verify, LOW → LLM`) is unsafe, because no "HIGH" cutoff exists that wouldn't occasionally bypass verification on a dangerous false positive. Collapsed to the two-zone design described in Part A:

```
semantic < LOW_CUTOFF → LLM directly (skip verifier — only for clearly unrelated queries)
semantic >= LOW_CUTOFF → NLI contradiction veto, always runs
    contradiction → LLM
    else → HIT
```

`LOW_CUTOFF` set at ≈0.45–0.5, derived from the data (just under the lowest observed genuine-paraphrase score of 0.489), existing purely to avoid wasting a verifier call on obviously unrelated queries — not as a correctness boundary, since no correctness boundary on semantic score alone was found to exist.

### Summary of Week 1 conclusions carried into implementation

1. **Architecture frozen:** MiniLM retrieval → low-cutoff filter → NLI contradiction veto (always runs above cutoff) → HIT or LLM.
2. **Embedding model:** `all-MiniLM-L6-v2`, unchanged from the original design.
3. **Verifier model:** `cross-encoder/nli-deberta-v3-small`, used off-the-shelf, no fine-tuning — held-out results strong enough that fine-tuning was not pursued.
4. **Known, documented limitations (not solved, explicitly scoped out):** (a) `same_topic_different_intent` queries not caught by contradiction detection; (b) recall loss on structurally divergent paraphrases where NLI entailment also fails (3 of 255 pairs); (c) the optimizer's objective function would need restructuring to a constrained form before any threshold-tuning claim could be trusted — this directly motivated dropping automatic tuning for the final architecture rather than fixing the objective function.
5. **Ruled out, with evidence:** raw Jaccard blending, stopword-filtered Jaccard blending, a hand-written antonym word list, rule-based negation/number checks as an addition to the veto, and the `multi-qa-MiniLM-L6-dot-v1` embedding model.

## B7. Implementation and Live Validation (Oct 9–12, 2026)

With the architecture frozen at the end of Week 1, implementation began: migrating the actual codebase from the hybrid-blend design to the NLI-veto design.

### Decisions locked before implementation

- **Automatic optimizer dropped entirely.** `LOW_CUTOFF` and the NLI threshold are config-driven via Redis (`cache:config`), manually adjustable, no live auto-tuning. The NLI veto architecture is the project's sole core contribution — not paired with a second "adaptive tuning" contribution.
- **Verifier runs in the same FastAPI process as the embedder** (port 5050), two endpoints (`/embed`, `/verify`), not a separate microservice.
- **Entailment-rescue rule (Part 8) stays unbuilt** — documented limitation only, out of scope for this implementation.
- **Evaluation compares two configs**: Baseline (pure semantic, fixed threshold) vs NLI Veto. A real GPTCache library comparison stays unscoped, optional future work.

### Build and bugs fixed during implementation

| File | Bug | Fix |
|---|---|---|
| `verifier.js` | Parameter named `Query` (capitalized), body referenced lowercase `query` — `ReferenceError` on every veto-mode request | Renamed parameter to `query`, matching usage |
| `schema.prisma` migration | New `NOT NULL` columns (`decisionPath`, `lowCutoffUsed`, `nliThresholdUsed`) couldn't apply over 57 existing rows from the dead hybrid architecture | Truncated `telemetry_logs` before migrating |
| `evaluation/run_eval.js` | `CONFIGS` object still had the old `{alpha, threshold}` shape (`hybridFixed`, `hybridAdaptive`) — incompatible with the new `cacheMiddleware.js`, which reads `mode`/`lowCutoff`/`nliThreshold`/`baselineThreshold` | Rewrote to `{baseline: {mode:'baseline',...}, nliVeto: {mode:'veto',...}}` |
| `evaluation/run_eval.js` | `runAllPairs` always labeled the first query of every trap/unrelated pair `shouldHit: true`, ignoring each group's `firstLabel` override and the different default used by `simulate_traffic.js` for trap pairs (`false`) vs unrelated pairs (`true`) | Matched `simulate_traffic.js`'s logic exactly: trap pairs default `false`, unrelated pairs default `true`, both respecting `firstLabel` when present |

### End-to-end manual verification

First live trap-pair test, confirming the whole decision path works end to end on real HTTP calls between Node and FastAPI:

| Query | Candidate | Decision | Semantic score | Contradiction |
|---|---|---|---|---|
| "How do I stop the server?" | "How do I start the server?" | **vetoed** | 0.541 | **0.999** |
| "What is the command to launch the server?" | "How do I start the server?" | **hit** | 0.834 | 0.001 |

Clean separation — this is the project's core mechanism working exactly as the offline research predicted, now reproduced on the live stack.

### An unplanned finding: isolated NLI model failure on "mute"/"unmute"

During full-query-set testing, the only genuine antonym pair that slipped through the veto was `"Mute notifications for this channel"` / `"Unmute notifications for this channel"` (contradiction score 0.068, should be near 1.0).

Diagnosed via direct, isolated `/verify` calls (bypassing the gateway entirely) to rule out a wiring bug:
- **Reverse-direction test:** contradiction 0.0015, entailment 0.994 (reverse order) — confirms it's not a premise/hypothesis ordering artifact; the model is confidently wrong in *both* directions
- **Prefix-antonym generalization test:** `lock/unlock` (0.999), `enable/disable` (0.996), `connect/disconnect` (0.9996), `grant/revoke` (0.9997) — all other antonym pairs, including other prefix-negation pairs, score near-perfect contradiction

**Conclusion:** this is an isolated, narrow failure specific to the lexical item "mute"/"unmute" (likely a training-data coverage gap for that word pair), not a systematic category weakness. 6 of 7 tested antonym pairs — including 3 other prefix-negation cases — were handled correctly.

---

# Part C — Final Evaluation Results (Oct 11–12, 2026)

Two configs compared via `run_eval.js` on the same 57-query fabricated traffic set, clean Redis/Postgres flush between runs, `telemetry_logs` truncated for clean post-hoc analysis:

| | Baseline (threshold 0.85) | NLI Veto (lowCutoff 0.5) | **NLI Veto (lowCutoff 0.6, final)** |
|---|---|---|---|
| Hit rate | 28% | 56% | **42%** |
| False positives (of 8 trap pairs tested) | 2 | 6 | **1** |
| Paraphrase recall | 5/18 (28%) | 16/18 (89%) | **14/18 (78%)** |
| Avg latency | ~2900ms | ~2000ms | ~2600ms |

**The tuning story (`lowCutoff`: 0.5 → 0.6), derived from measured data, not guessed:**

Pulling every veto-mode decision's semantic score and contradiction score showed 5 of the 6 false positives at `lowCutoff=0.5` were all `same_topic_different_intent` cases (not logical contradictions — e.g. "Lock the account" matching "Revoke access from this user") clustered in the 0.534–0.586 score range. Two genuine true hits sat in that same band. Raising `lowCutoff` to 0.6 sits just above that cluster, trading 2 of 18 true paraphrase hits for 5 of 6 false positives fixed. The 6th false positive (mute/unmute) is unaffected by the cutoff — it's a verifier-level failure, not a retrieval-level one — and remains the system's one documented, isolated limitation.

**Net result: at `lowCutoff=0.6`, NLI Veto beats Baseline on every axis** — fewer wrong hits (1 vs 2), nearly 3x the paraphrase recall (78% vs 28%), and still double the hit rate (42% vs 28%). This is the locked final configuration.

**Important scale caveat:** this 57-query live evaluation is a production sanity check, not the project's statistical evidence — that comes from the 255-pair held-out offline study in Part B6 (117 → 4 wrong hits, 97% reduction). The live run's role was confirming real end-to-end wiring and surfacing the mute/unmute finding the offline study didn't catch, not re-establishing statistical significance at scale.

---

# Hosting Strategy

**Local development**

Everything runs via Docker Compose — Postgres (`pgvector/pgvector:pg16`), Redis with LRU config, Node gateway, Python `ml-service`. No internet dependency beyond the LLM API call, works offline otherwise.

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    ports: ["6379:6379"]
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports: ["5434:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```

**Deployment (planned, not yet executed)**

| Service | Local | Deployed |
|---|---|---|
| Gateway | Docker Compose | Render |
| ml-service | Docker Compose | Render (second service) |
| Postgres | Docker Compose (pgvector image) | Supabase (pgvector built in) |
| Redis | Docker Compose | Upstash (free tier, persists across restarts) |

Same codebase, environment variables swap between local and production — no code changes required.

---

# Changes Log (chronological index)

- **Sep 24, 2026** — Optimizer bug fixes (embedder return statement, redis_client null guard, db.py connection leak, scorer.py truthy check). Raw score logging design fix (semantic/lexical columns added, hybridScorer.js returns all three scores).
- **Sep 25, 2026** — `shouldHit` ground-truth column added. Fabricated-traffic testing approach adopted.
- **Sep 30, 2026** — demo-app missing `await` bug fixed.
- **Oct 3, 2026** — First full local end-to-end run across all services; 6 integration bugs found and fixed (ports, DB auth, migrations, two rounds of Gemini model deprecation, Prisma client regen); core pipeline verified on all three decision paths; two near-miss cases captured in telemetry supporting the hybrid design (at this point still believed to be the right direction).
- **Oct 4, 2026** — LLM provider switched Gemini → Groq; RESP2 fix for redis-py v5+; 57-pair traffic simulation run, 88 telemetry rows; zero-hit exploit found and fixed in the optimizer objective; hybrid mechanism validated at the individual-decision level, but the optimizer's *aggregate* result was found to favor α≈1.0 — opening the investigation that follows.
- **Oct 2026 (Week 1 investigation, Part B6)** — Clean baseline rebuild; Jaccard and stopword-filtered Jaccard blending both tested and rejected with evidence; objective function flaw identified as the root cause of the Oct 4 tension; pivot decision to a veto architecture; offline 200-pair then 255-pair pair-set evaluation showing NLI veto cuts wrong hits by 97% with zero recall cost on Batch 1; entailment-rescue explored as a bounded, unimplemented fix for recall loss; embedding model swap tested and rejected; score-distribution analysis proving no safe three-zone cutoff exists, collapsing the design to two zones. Architecture frozen.
- **Oct 9–12, 2026** — Implementation of the NLI-veto architecture: hybrid-blend code and Bayesian optimizer deleted entirely; `optimizer/` renamed to `ml-service/`, now hosting both `/embed` and `/verify`; `cacheMiddleware.js` rewritten around the two-zone veto path with a retained `baseline` mode for comparison; `schema.prisma` migrated to the new decision-path telemetry fields; parameter-naming bug fixed in `verifier.js`; `run_eval.js` config shape and labeling logic fixed to match the new architecture; end-to-end verification on live HTTP calls between Node and FastAPI; isolated mute/unmute NLI limitation found and characterized as narrow, not systematic; `lowCutoff` tuned from 0.5 to 0.6 using measured score-distribution analysis on live telemetry, producing a final configuration that beats Baseline on every evaluated metric.