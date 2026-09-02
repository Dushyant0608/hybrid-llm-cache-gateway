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
          ┌─────────────────────┐
          │   Python Worker     │
          │                     │
          │ reads telemetry     │
          │ runs gp_minimize    │
          │ updates Redis config│
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
9. **Log** — write decision row to telemetry table regardless of hit or miss

---

## Optimization Loop

Every 30 minutes the Python worker:

1. Reads last N rows from `telemetry_logs` table
2. Checks minimum log threshold — skips cycle if fewer than 30 rows exist
3. Calculates a performance score for the current (α, threshold) pair:
   `performance = hit_rate - (false_positive_rate × penalty_weight)`
4. Passes this measurement to `gp_minimize` from scikit-optimize
5. scikit-optimize returns the next (α, threshold) pair to try — chosen intelligently based on all past measurements, not randomly
6. Worker writes new values to `cache:config` key in Redis
7. Gateway reads new values on next request

Each 30-minute cycle is one experiment. The system is not mining historical data to find a pattern — it is running live trials, one after another, each informed by everything before it. The Gaussian Process builds a map of which (α, threshold) regions perform well and directs the next trial toward unexplored promising areas rather than guessing randomly.

---

## Evaluation Plan

Three configurations tested on the same fixed query set:

| Config | Description |
|---|---|
| Baseline | Pure semantic, fixed α=1.0, fixed threshold=0.85 (GPTCache style) |
| Hybrid Fixed | Fusion formula, fixed α=0.7, fixed threshold=0.85 |
| Hybrid Adaptive | Full system, Bayesian optimizer running |

Query set composition:
- Paraphrase pairs — same meaning, different words (should hit)
- Trap pairs — similar topic, opposite meaning like start/stop (should miss)
- Unrelated queries — completely different topics (should always miss)

Metrics measured:
- Hit rate — what % of requests were served from cache
- False positive rate — what % of cache hits were actually wrong answers
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
│   │   │   ├── hybridScorer.js       ✅ α × semantic + (1-α) × lexical
│   │   │   ├── embedder.js           ⬜ HTTP client → Python embedder
│   │   │   └── gemini.js             ⬜ Gemini API call on cache miss
│   │   ├── services/
│   │   │   ├── redis.js              ✅ ioredis client + config reader/writer
│   │   │   └── telemetry.js          ⬜ Async log writer to Postgres
│   │   └── config/
│   │       └── defaults.js           ✅ Cold start α and threshold init
│   ├── prisma/
│   │   ├── schema.prisma             ✅ CachedResponse + TelemetryLog models
│   │   ├── prisma7.config.ts         ✅
│   │   └── migrations/               ✅ Init migration done
│   ├── app.js                        ✅ Express app setup
│   ├── server.js                     ✅ Entry point + initConfig
│   └── package.json
│
├── optimizer/                        # Python services
│   ├── embedder.py                   ⬜ MiniLM-L6 HTTP server (always running)
│   ├── worker.py                     ⬜ Bayesian optimizer (runs every 30 min)
│   ├── db.py                         ⬜ Postgres connection + telemetry queries
│   ├── redis_client.py               ⬜ Redis connection + config writer
│   ├── bayesian.py                   ⬜ gp_minimize wrapper
│   ├── scorer.py                     ⬜ Performance metric calculation
│   └── requirements.txt              ⬜
│
├── evaluation/                       # Evaluation harness
│   ├── query_set/
│   │   ├── paraphrases.json          ⬜ Same meaning, different words
│   │   ├── trap_pairs.json           ⬜ Similar topic, opposite meaning
│   │   └── unrelated.json            ⬜ Completely different topics
│   ├── run_eval.js                   ⬜ Replays queries, records results
│   └── results/                      ⬜ Output CSVs and charts
│
├── demo-app/                         # Minimal demo
│   ├── index.js                      ⬜ Simple Express app routing through gateway
│   └── package.json                  ⬜
│
├── docker-compose.yml                ✅ Postgres (pgvector) + Redis
├── .env                              ✅
├── .env.example                      ⬜
├── plan.md                           ✅
└── README.md                         ⬜
```

---

## Build Strategy

### Phase 1 — Infrastructure (Week 1)
- Docker Compose running Redis + Postgres locally
- pgvector extension enabled
- Prisma schema: `CachedResponse` table and `TelemetryLog` table
- Gateway skeleton — Express server that proxies requests through with no caching yet
- MiniLM-L6 embedding call working end to end via sentence-transformers

**Done when:** A request flows through the gateway, gets embedded locally, and comes back. Nothing cached yet.

---

### Phase 2 — Baseline cache (Week 2)
- L1 Redis exact match check with TTL
- pgvector nearest neighbor query in Postgres
- Fixed threshold decision (α=1.0, threshold=0.85 — pure semantic)
- Cache miss stores to Redis + Postgres
- Telemetry logging on every decision

**Done when:** The system works as a functional semantic cache. This is your baseline for evaluation. Run your trap pairs manually and observe the false positives happening.

---

### Phase 3 — Hybrid scorer (Week 3)
- Implement Jaccard scorer in Node (~20 lines)
- Implement fusion formula with fixed α=0.7
- Re-run trap pairs and confirm false positive rate drops

**Done when:** "Start server" and "Stop server" no longer collide. You have a number showing improvement over baseline.

---

### Phase 4 — Python worker (Week 4-5)
- Learn just enough Python: psycopg2, redis-py, basic functions
- `db.py` reads recent telemetry rows
- `scorer.py` calculates hit rate and false positive rate from logs
- `bayesian.py` wraps `gp_minimize` — takes past (α, threshold, score) tuples, returns next pair to try
- `worker.py` ties it all together, runs on a schedule with 30-log minimum guard
- Gateway reads `cache:config` from Redis instead of hardcoded defaults

**Done when:** You can watch α and threshold values changing in Redis as the worker runs.

---

### Phase 5 — Evaluation (Week 6-7)
- Build `run_eval.js` — replays all three query set categories in a fixed order
- Run all three configurations (Baseline, Hybrid Fixed, Hybrid Adaptive) separately
- Record hit rate, false positive rate, latency per configuration
- Plot parameter convergence over time for Hybrid Adaptive

**Done when:** You have a table and at least one graph showing Hybrid Adaptive outperforms Baseline on the hit rate vs false positive tradeoff.

---

### Phase 6 — Writeup + polish (Week 8)
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

---

## Worker Guard Condition

The Python worker checks for a minimum number of telemetry logs before running optimization. If fewer than 30 logs exist for the current cycle, the worker skips and waits for the next cycle.

```python
def run_optimization_cycle():
    logs = fetch_recent_logs()

    if len(logs) < 30:
        print("Not enough data yet, skipping this cycle")
        return

    score = calculate_performance(logs)
    next_params = bayesian_suggest(score)
    update_redis_config(next_params)
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

The system cannot automatically label a cache hit as correct or incorrect in live traffic. Two mitigations:

- Evaluation phase uses synthetic query pairs with known ground truth — trap pairs and paraphrase pairs where correct behavior is predefined
- Production approximation uses a client retry heuristic — if the same client sends a similar query within 60 seconds of a cache hit, that hit is flagged as a probable false positive in telemetry

Establishing reliable ground truth in production caching systems is an open research problem, acknowledged as a limitation in the writeup.

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