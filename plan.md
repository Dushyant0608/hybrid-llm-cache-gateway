# Hybrid Semantic Cache Middleware

## Research Gap

LLM APIs are expensive and slow. Semantic caching systems like GPTCache solve this by storing past responses and reusing them when a similar question comes in — instead of calling the LLM again. They convert questions into meaning vectors and use cosine similarity to decide if two questions are "close enough."

This works, but has two known problems that existing literature acknowledges and hasn't fully solved:

**Problem 1 — False positives from pure semantic matching**
"Start the server" and "Stop the server" produce nearly identical meaning vectors because they're about the same topic. A pure semantic cache returns the wrong cached answer. A 2025 study on industrial query caching confirmed this exact failure mode — a query about one system's data was served an answer meant for a completely different system because the embeddings looked close enough.

**Problem 2 — Hardcoded parameters**
Every semantic cache has two critical settings: a similarity threshold (how similar is "similar enough") and if using hybrid scoring, a fusion weight α. These are set once by the developer and never change. Research shows optimal threshold values range from 0.88 to 0.97 depending on the use case — a single hardcoded value is always wrong for some portion of traffic.

**The gap:**
No existing system combines lexical and semantic scoring in the cache decision layer while simultaneously learning both the fusion weight and the similarity threshold from live traffic automatically. The pieces exist separately in literature — hybrid retrieval in search engines, Bayesian hyperparameter tuning in ML — but their combination applied specifically to LLM response caching has not been done.

---

## Solution

A middleware service that sits between any Node.js application and an LLM API. The application never calls the LLM directly — it calls this service, which either returns a cached response instantly or forwards to the LLM and stores the result.

**Two contributions:**

**1. Hybrid lexical-semantic scoring**
Instead of relying purely on meaning vectors, every cache decision uses a weighted fusion of two signals:

```
Final Score = α × semantic_score + (1 - α) × lexical_score
```

- `semantic_score` — cosine similarity between meaning vectors (catches paraphrases)
- `lexical_score` — Weighted Jaccard similarity between keyword sets (catches keyword mismatches like start vs stop)
- `α` — the fusion weight, controls how much to trust each signal

This structurally prevents false positives that fool pure semantic systems.

**2. Bayesian optimization loop**
Instead of hardcoding α and the similarity threshold, a background Python worker reads cache decision logs and uses Bayesian optimization (via scikit-optimize) to find better values from real traffic. It updates the live parameters in Redis every 30 minutes. The gateway reads the new values immediately — no restart required.

Over time the system learns what α and threshold actually work for its traffic, rather than relying on developer intuition at setup time.

---

## Architecture

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

---

## Request Flow

1. Request hits the gateway
2. **L1 check** — Redis exact string match. Hit → return instantly
3. **Embed** — MiniLM-L6 generates vector locally (3-5ms, no API call)
4. **L2 check** — pgvector finds top 5 closest stored vectors
5. **Score** — compute semantic score (cosine) + lexical score (Jaccard) for each candidate
6. **Fuse** — `score = α × semantic + (1-α) × lexical` using current α from Redis
7. **Decide** — if best score > threshold (from Redis), return cached response. Otherwise call Gemini API for a real LLM response
8. **Store** — on miss, store query + embedding + response in Postgres and Redis (with TTL)
9. **Log** — write decision row to telemetry table including:
   - `semanticScore` — raw cosine similarity (before blending)
   - `lexicalScore` — raw Jaccard score (before blending)
   - `similarityScore` — final blended score (for reference)
   - `shouldHit` — ground truth label (provided by simulator, null in real traffic)

---

## Score Data Flow (Critical Design Decision)

### Problem discovered

The gateway originally computed both raw scores (semantic + lexical), blended them into one `similarityScore`, and only logged the blended result. The raw components were discarded.

The optimizer needs the raw scores to answer: "what if α was 0.3 instead of 0.7?" — which requires recomputing `candidate_α × semantic + (1 - candidate_α) × lexical` per log row. With only the blended score stored, this is mathematically impossible — you can't un-blend `0.7A + 0.3B = 0.82` back into A and B.

### Fix

Log all three values in every telemetry row:

| Column | What it stores | Who uses it |
|--------|---------------|-------------|
| `semanticScore` | Raw cosine similarity from pgvector | Optimizer (for re-simulation) |
| `lexicalScore` | Raw Weighted Jaccard score | Optimizer (for re-simulation) |
| `similarityScore` | `α × semantic + (1-α) × lexical` | Reference / debugging |
| `shouldHit` | Ground truth label from simulator | Optimizer (for false positive rate) |

### How the optimizer uses them

```python
def objective(params):
    candidate_alpha, candidate_threshold = params
    logs = fetch_recent_logs()

    simulated_hits = 0
    false_positives = 0
    for log in logs:
        semantic, lexical, should_hit = log.semanticScore, log.lexicalScore, log.shouldHit
        # Re-blend with candidate alpha
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

Now `gp_minimize` gets different scores for different `[alpha, threshold]` candidates — it can actually learn.

---

## Optimization Loop

Every 30 minutes the Python worker:

1. Reads last N rows from `telemetry_logs` table (including `semanticScore`, `lexicalScore`, `shouldHit`)
2. Checks minimum log threshold — skips cycle if fewer than 30 rows exist
3. Defines `objective(params)` that re-simulates hit/miss for each log using candidate `[alpha, threshold]`
4. Passes `objective` to `gp_minimize` from scikit-optimize
5. scikit-optimize evaluates multiple candidates, each getting a different score based on the re-simulation
6. Worker writes the best `[alpha, threshold]` to `cache:config` key in Redis
7. Gateway reads new values on next request

Each 30-minute cycle is one experiment. The Gaussian Process builds a map of which (α, threshold) regions perform well and directs the next trial toward unexplored promising areas rather than guessing randomly.

---

## Ground Truth via Fabricated Traffic

### Why fabricated traffic

In real production, you can't automatically know if a cache hit returned the *correct* answer. The system has no way to label a hit as "right" or "wrong" without human review. This is an open research problem.

**Our approach:** Build the system for production, but test it with a traffic simulator that sends queries with known ground truth labels. This lets us:

- Measure real false positive rates (not guesses)
- Give the optimizer actual `shouldHit` labels to learn from
- Run controlled experiments (Baseline vs Hybrid Fixed vs Hybrid Adaptive)
- Validate the system works before deploying on real traffic

### How it works

The traffic simulator sends requests to the gateway with an extra field:

```json
{
    "query": "How do I start the server?",
    "shouldHit": true
}
```

The gateway passes `shouldHit` through to telemetry logging. In real production traffic, this field would be `null` — the system still works, the optimizer just uses hit rate and latency alone without false positive penalties.

### Query set composition

| Category | Purpose | `shouldHit` label | Example |
|----------|---------|-------------------|---------|
| Paraphrase pairs | Same meaning, different words — should hit | `true` (after first query cached) | "How to start the server" → "What's the command to launch the server" |
| Trap pairs | Similar topic, opposite meaning — should NOT hit | `false` | "Start the server" → "Stop the server" |
| Unrelated queries | Completely different topics — should miss | `false` | "Start the server" → "What's the weather today" |

---

## Evaluation Plan

Three configurations tested on the same fabricated traffic:

| Config | Description |
|---|---|
| Baseline | Pure semantic, fixed α=1.0, fixed threshold=0.85 (GPTCache style) |
| Hybrid Fixed | Fusion formula, fixed α=0.7, fixed threshold=0.85 |
| Hybrid Adaptive | Full system, Bayesian optimizer running |

Metrics measured:
- Hit rate — what % of requests were served from cache
- False positive rate — what % of cache hits were actually wrong answers (using `shouldHit` ground truth)
- Latency — average response time per configuration
- Parameter convergence — how α and threshold change over time as optimizer runs

The primary claim to prove: Hybrid Adaptive achieves a better hit rate vs false positive rate tradeoff than the Baseline.

---

## Directory Structure

```
hybrid-llm-cache-gateway/
│
├── gateway/                          # Node.js Express service
│   ├── src/
│   │   ├── middleware/
│   │   │   ├── cacheMiddleware.js    ✅ Main middleware — orchestrates full flow
│   │   │   ├── exactMatch.js         ✅ Redis L1 exact match check
│   │   │   ├── semanticSearch.js     ✅ pgvector cosine similarity search + store
│   │   │   ├── lexicalScorer.js      ✅ Weighted Jaccard similarity
│   │   │   ├── hybridScorer.js       🔧 Returns raw semantic + lexical alongside blended score
│   │   │   ├── embedder.js           ✅ HTTP client → Python embedder
│   │   │   └── gemini.js             ✅ Gemini API call on cache miss
│   │   ├── service/
│   │   │   ├── redis.js              ✅ ioredis client + config reader/writer
│   │   │   ├── telemetry.js          🔧 Updated to accept semanticScore, lexicalScore, shouldHit
│   │   │   └── prisma.js             ✅ Prisma client setup
│   │   └── config/
│   │       └── default.js            ✅ Cold start α and threshold init
│   ├── prisma/
│   │   ├── schema.prisma             🔧 Add semanticScore, lexicalScore, shouldHit columns
│   │   ├── prisma7.config.ts         ✅
│   │   └── migrations/               🔧 New migration needed
│   ├── app.js                        ✅ Express app setup
│   ├── server.js                     ✅ Entry point + initConfig
│   └── package.json                  ✅
│
├── optimizer/                        # Python services
│   ├── embedder.py                   ✅ MiniLM-L6 HTTP server (FastAPI)
│   ├── db.py                         ✅ Postgres connection + telemetry queries (bug-fixed)
│   ├── redis_client.py               ✅ Redis connection + config read/write (bug-fixed)
│   ├── scorer.py                     🔧 Rework: re-simulate with candidate params + shouldHit FP rate
│   ├── bayesian.py                   ⬜ gp_minimize wrapper with proper objective function
│   ├── worker.py                     ⬜ Ties it all together on 30-min loop
│   └── requirements.txt              ✅
│
├── evaluation/                       # Fabricated traffic testing
│   ├── query_set/
│   │   ├── paraphrases.json          ⬜ Same meaning, different words (shouldHit: true)
│   │   ├── trap_pairs.json           ⬜ Similar topic, opposite meaning (shouldHit: false)
│   │   └── unrelated.json            ⬜ Completely different topics (shouldHit: false)
│   ├── simulate_traffic.js           ⬜ Sends labeled queries to gateway over time
│   ├── run_eval.js                   ⬜ Three-config comparison (Baseline vs Fixed vs Adaptive)
│   └── results/                      ⬜ Output CSVs and charts
│
├── demo-app/                         # Minimal demo
│   ├── index.js                      ⬜ Simple Express app routing through gateway
│   └── package.json                  ⬜
│
├── docker-compose.yml                ✅ Postgres (pgvector) + Redis
├── .env                              ✅
├── .env.example                      ⬜
├── plan.md                           ✅ (this file)
└── README.md                         ⬜
```

**Legend:** ✅ = done and working, 🔧 = exists but needs update, ⬜ = not built yet

---

## Changes Log

### Bugs fixed in optimizer (Sep 24, 2026)

| File | Bug | Fix |
|------|-----|-----|
| `embedder.py` | `/embed` endpoint had no `return` statement — always returned `null` | Added `return {"embedding": vec}` |
| `redis_client.py` | `get_config()` crashed with `TypeError` when Redis key didn't exist (`json.loads(None)`) | Added `None` guard before `json.loads` |
| `db.py` | Connection leak — `cur.close()` and `conn.close()` unreachable on exception | Wrapped in `try/finally` with `conn = None` / `cur = None` init before try block |
| `scorer.py` | `log[0] == True` fragile comparison | Changed to `log[0]` (truthy check) |

### Design fix: raw score logging (Sep 24, 2026)

**Problem:** The optimizer's `objective(params)` function received candidate `[alpha, threshold]` from `gp_minimize` but couldn't use them because the telemetry table only stored the pre-blended `similarityScore`. The raw `semanticScore` and `lexicalScore` were computed in `hybridScorer.js`, blended, and the individual components were thrown away.

**Impact:** `gp_minimize` got the same score for every candidate — it literally could not optimize anything. The loop ran but learned nothing.

**Fix requires changes in:**
1. `schema.prisma` — add `semanticScore`, `lexicalScore` columns
2. `hybridScorer.js` — return all three scores (semantic, lexical, blended)
3. `cacheMiddleware.js` — pass raw scores to telemetry logger
4. `telemetry.js` — accept and write the new fields
5. `db.py` — query the new columns
6. `scorer.py` — re-simulate hit/miss with candidate params using raw scores

### New: ground truth via `shouldHit` (Sep 25, 2026)

Added `shouldHit` boolean column to `TelemetryLog` — carries the expected correct answer from the traffic simulator. Lets the optimizer compute real false positive rates instead of approximations. Value is `null` for real (non-simulated) traffic.

### New: fabricated traffic approach (Sep 25, 2026)

Instead of testing on real production traffic (where ground truth is unknowable), the system is tested with a traffic simulator (`simulate_traffic.js`) that sends queries with known `shouldHit` labels. The system is built production-ready, but validated with controlled fabricated traffic.

---

## Build Strategy (Updated)

### Phase 1 — Infrastructure ✅ DONE
- Docker Compose running Redis + Postgres locally
- pgvector extension enabled
- Prisma schema: `CachedResponse` table and `TelemetryLog` table
- Gateway skeleton — Express server that proxies requests through
- MiniLM-L6 embedding call working end to end via sentence-transformers

---

### Phase 2 — Baseline cache ✅ DONE
- L1 Redis exact match check with TTL
- pgvector nearest neighbor query in Postgres
- Fixed threshold decision (α=1.0, threshold=0.85 — pure semantic)
- Cache miss stores to Redis + Postgres
- Telemetry logging on every decision

---

### Phase 3 — Hybrid scorer ✅ DONE
- Jaccard scorer in Node
- Fusion formula with configurable α from Redis
- `hybridScorer.js`, `lexicalScorer.js` working

---

### Phase 4 — Schema + telemetry updates ⬜ NEXT
Update the gateway to log raw scores and ground truth labels.

**4a. Schema migration**
- Add `semanticScore Float?` to `TelemetryLog` (raw cosine similarity)
- Add `lexicalScore Float?` to `TelemetryLog` (raw Jaccard score)
- Add `shouldHit Boolean?` to `TelemetryLog` (ground truth from simulator)
- Keep existing `similarityScore` as the blended score (rename optional but not required)
- Run `npx prisma migrate dev`

**4b. Gateway code updates**
- `hybridScorer.js` — return `{ score, semantic, lexical }` instead of just the blended number
- `cacheMiddleware.js` — destructure raw scores and pass them + `shouldHit` (from `req.body`) to telemetry
- `telemetry.js` — accept `semanticScore`, `lexicalScore`, `shouldHit` and write them to the database

**Done when:** A request logged to `telemetry_logs` includes all three score columns and `shouldHit` (null for requests without the field).

---

### Phase 5 — Optimizer (Python worker) ⬜
Build the Bayesian optimization loop with the correct objective function.

**5a. Update existing files**
- `db.py` — update SQL query to select `semanticScore`, `lexicalScore`, `shouldHit` alongside existing columns
- `scorer.py` — rework to accept candidate `[alpha, threshold]`, re-simulate hit/miss per log using raw scores, compute real false positive rate using `shouldHit`

**5b. New files**
- `bayesian.py` — wraps `gp_minimize`, defines `objective(params)` that calls scorer with candidate params
- `worker.py` — main loop: fetch logs → guard (min 30 rows) → run bayesian → write new config to Redis → sleep 30 minutes

**Done when:** Worker runs, α and threshold values change in Redis based on telemetry data, and different candidate params produce different scores.

---

### Phase 6 — Fabricated traffic + evaluation ⬜
Build the traffic simulator and run the three-config comparison.

**6a. Query sets**
- `evaluation/query_set/paraphrases.json` — same meaning, different words
- `evaluation/query_set/trap_pairs.json` — similar topic, opposite meaning
- `evaluation/query_set/unrelated.json` — completely different topics

**6b. Traffic simulator**
- `evaluation/simulate_traffic.js` — reads query sets, sends labeled requests to gateway with `shouldHit` field, spreads them over time to generate realistic telemetry for the optimizer

**6c. Three-config evaluation**
- `evaluation/run_eval.js` — runs Baseline (α=1.0), Hybrid Fixed (α=0.7), Hybrid Adaptive (optimizer running) on the same query set, records metrics per config
- Output: CSVs and comparison tables in `evaluation/results/`

**Done when:** You have a table and at least one graph showing Hybrid Adaptive outperforms Baseline on the hit rate vs false positive tradeoff.

---

### Phase 7 — Demo app + writeup ⬜
- `demo-app/` — minimal Express app that routes through the gateway
- README with architecture diagram and setup instructions
- Mini paper structure: Abstract, Problem, Related Work, System Design, Evaluation, Conclusion
- Cite: GPTCache, Category-Aware Caching paper, INFOCOM 2026 paper (differentiate explicitly), Temporal Semantic Caching paper
- Short demo video showing optimizer changing params live

---

## Key Technical Decisions

| Decision | Choice | Reason |
|---|---|---|
| Embedding model | MiniLM-L6 (local, sentence-transformers) | Free, unlimited, 3-5ms latency, no API dependency |
| LLM for responses | Gemini API | Called only on cache miss, free tier sufficient |
| Vector DB | PostgreSQL + pgvector | Avoids dedicated vector DB, Prisma v7 supports it natively |
| Lexical metric | Weighted Jaccard | ~20 lines of JS, no library, interpretable |
| Optimizer | scikit-optimize gp_minimize | Correct tool, well documented, no need to implement Bayesian from scratch |
| Parameter store | Redis key | Both Node and Python can read/write, zero latency for gateway |
| Telemetry store | PostgreSQL table | Persistent, queryable, already in stack |
| Raw score logging | Store semantic + lexical separately | Optimizer must re-blend with candidate α to evaluate alternatives |
| Ground truth | `shouldHit` column from simulator | Real FP rate instead of heuristic approximation |
| Testing approach | Fabricated traffic with known labels | Production-ready code, validated with controlled experiments |

---

## Worker Guard Condition

The Python worker checks for a minimum number of telemetry logs before running optimization. If fewer than 30 logs exist for the current cycle, the worker skips and waits for the next cycle.

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

This prevents the optimizer from making wild guesses on insufficient data during the first 30 minutes or during low traffic periods.

---

## Cold Start Behavior

On first boot, the gateway writes default values to Redis only if `cache:config` does not already exist:

```js
const DEFAULTS = { alpha: 0.7, threshold: 0.85 }

async function initConfig() {
    const existing = await redis.get('cache:config')
    if (!existing) {
        await redis.set('cache:config', JSON.stringify(DEFAULTS))
    }
}
```

Redis is always the source of truth. The hardcoded defaults are only a fallback for the very first boot. During the first 30 minutes the system operates on these defaults — caching works normally, telemetry accumulates, and the optimizer waits until enough data exists before running its first cycle.

---

## Redis Memory Management

Redis lives in RAM and cannot grow indefinitely. Two mechanisms keep it lean:

**TTL — every write expires automatically**

Every response written to Redis gets a 24-hour expiry. After that it auto-deletes. If the same query comes in after 24 hours it is a Redis miss but a Postgres hit — slightly slower but still no LLM call.

```js
await redis.set(queryKey, response, 'EX', 86400)
```

**LRU eviction — Redis manages its own memory limit**

When Redis hits its memory ceiling it automatically evicts the least recently used entries. Hot queries stay, cold ones fall back to Postgres. Configured in docker-compose:

```yaml
command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

**Why this is not over-engineering**

Any system writing to Redis indefinitely will eventually crash with an out-of-memory error. TTL and LRU are standard production patterns, not added complexity. The fix is 3 lines of code total.

**Responsibility split between the two stores**

| | Redis | Postgres |
|---|---|---|
| Purpose | Exact match, instant response | Semantic search, permanent storage |
| Lives in | RAM | Disk |
| Speed | Sub-millisecond | 10-50ms |
| Stores | Recent + frequent queries only | Everything permanently |
| When full | LRU evicts cold entries | Never fills (disk) |

Nothing is ever lost. If Redis evicts an entry it still lives in Postgres. Redis is the fast lane, Postgres is the source of truth.

---

## Known Limitations and Defenses

**Ground truth problem**

The system cannot automatically label a cache hit as correct or incorrect in real production traffic. Our mitigation:

- Testing uses a traffic simulator that sends queries with known `shouldHit` labels — paraphrase pairs and trap pairs where correct behavior is predefined
- The `shouldHit` column is `null` for real traffic — the optimizer falls back to optimizing hit rate and latency alone, without false positive penalties
- Establishing reliable ground truth in production caching systems is an open research problem, acknowledged as a limitation in the writeup

**Why Bayesian optimization over a contextual bandit or EMA**

- EMA treats α and threshold independently and misses their interaction — a threshold of 0.91 behaves differently depending on what α is set to. Bayesian optimization models the joint space.
- The search space is non-convex — there is no single smooth hill to climb. Bayesian makes no convexity assumption.
- Sample efficiency — with 30-minute cycles and moderate traffic, each experiment is expensive. Bayesian extracts maximum information from minimum trials. Bandits need far more data to converge to the same quality.

Trade-off acknowledged: for very high traffic systems a contextual bandit would be more practical. Noted as future work.

**Embedding latency**

MiniLM-L6 runs locally at 3-5ms — this concern does not apply. If an external embedding API were used instead, a cache hit would still cost ~120ms total versus 2000-5000ms for a direct LLM call, making it worthwhile on balance.

---

## Hosting Strategy

**Local development**

Everything runs via Docker Compose — Postgres (pgvector/pgvector:pg16 image), Redis with LRU config, Node gateway, Python optimizer. No internet dependency, no free tier limits, works offline.

```yaml
# docker-compose.yml (local development)
version: '3.8'

services:
  gateway:
    build: ./gateway
    ports:
      - "3000:3000"
    env_file: .env
    depends_on:
      - postgres
      - redis

  optimizer:
    build: ./optimizer
    env_file: .env
    depends_on:
      - postgres
      - redis

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: password
      POSTGRES_DB: hybridcache
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

**Deployment**

External managed services replace the local containers. Docker Compose shrinks to just the two application services:

```yaml
# docker-compose.yml (production)
version: '3.8'

services:
  gateway:
    build: ./gateway
    ports:
      - "3000:3000"
    env_file: .env

  optimizer:
    build: ./optimizer
    env_file: .env
```

| Service | Local | Deployed |
|---|---|---|
| Gateway | Docker Compose | Render |
| Optimizer | Docker Compose | Render (second service) |
| Postgres | Docker Compose (pgvector image) | Supabase (pgvector built in) |
| Redis | Docker Compose | Upstash (free tier, persists across restarts) |

Environment variables swap between local and production — no code changes:

```bash
# .env (local)
DATABASE_URL=postgresql://admin:password@localhost:5432/hybridcache
REDIS_URL=redis://localhost:6379
GEMINI_API_KEY=your_key

# .env (production)
DATABASE_URL=postgresql://your-supabase-connection-string
REDIS_URL=rediss://your-upstash-url
GEMINI_API_KEY=your_key
```

Same codebase, different environment variables.