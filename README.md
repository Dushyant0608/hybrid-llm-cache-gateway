<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=700&size=32&pause=1000&color=00D9FF&center=true&vCenter=true&width=700&lines=SentryCache;NLI-Verified+Semantic+Caching;Gateway+for+LLM+APIs" alt="Typing SVG" />

<br/>

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://prisma.io)
[![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io)
[![PyTorch](https://img.shields.io/badge/PyTorch-EE4C2C?style=for-the-badge&logo=pytorch&logoColor=white)](https://pytorch.org)

</div>

---

## 📌 Overview

**** is an NLI-verified semantic caching gateway for LLM APIs. Pure semantic caching returns wrong answers whenever two different questions produce near-identical embeddings — "Start the server" and "Stop the server" score 0.94+ cosine similarity despite meaning opposite things. SentryCache closes that gap with a **contradiction veto**: every semantic match above a low-confidence cutoff is checked by a pretrained NLI (Natural Language Inference) model before it's allowed to serve as a cache hit, so the system never returns a logically contradictory answer regardless of how similar the embeddings look.

```
Client → Express Gateway → Redis (exact match) → pgvector (semantic search) → NLI Verifier (veto) → Cache HIT or LLM call
```

This architecture replaced an earlier hybrid lexical+semantic blend with Bayesian parameter tuning, which was fully built, tested, and found structurally broken — raw word-overlap scoring rates trap pairs *higher* than genuine paraphrases, so blending it in made results worse, not better. The full investigation, evidence, and pivot are documented in [`plan.md`](./plan.md).

---

## ✨ Features

| Feature | Description |
|---|---|
| 🛡️ **NLI Contradiction Veto** | Every borderline semantic match is checked by `cross-encoder/nli-deberta-v3-small` before being served — blocks false positives a pure similarity score can't catch |
| 🎯 **Two-Zone Decision Architecture** | Below a low cutoff → straight to the LLM; above it → veto always runs. No "safe" similarity score is ever auto-trusted, because score distributions for matches and non-matches fully overlap |
| ⚡ **Local Embeddings** | MiniLM-L6 runs locally via a FastAPI microservice — no per-query embedding API cost or latency |
| 🔄 **Hot-Reloadable Config** | `lowCutoff` / `nliThreshold` live in Redis and are read fresh on every request — tune in production with no restart |
| 🗄️ **Two-Tier Cache** | Redis for exact-match hits (24h TTL, LRU eviction), PostgreSQL + pgvector for semantic search, nothing is ever lost on eviction |
| 📊 **Full Decision Telemetry** | Every request logs semantic score, contradiction/entailment scores, and the decision path taken — fully auditable |
| 🧪 **Labeled Evaluation Harness** | Fabricated traffic with known ground-truth labels (`shouldHit`) to measure real false-positive rates, since production traffic has no automatic correctness signal |

---

## 🛠️ Tech Stack

**Gateway**
- Node.js + Express.js

**ML Service**
- Python + FastAPI
- `sentence-transformers` — MiniLM-L6 embeddings + NLI cross-encoderSentryCache
- PyTorch

**Database**
- PostgreSQL + `pgvector` (semantic nearest-neighbor search)
- Prisma ORM

**Cache**
- Redis (`ioredis`) — exact-match L1 cache + shared hot-reloadable config

**LLM**
- Groq API (`openai/gpt-oss-20b`) — called only on a cache miss

---

## 🚀 Quick Start

### Prerequisites
- Node.js
- Python 3.10+
- Docker (for PostgreSQL + Redis)

### 1. Clone the repository

```bash
git clone https://github.com/Dushyant0608/hybrid-llm-cache-gateway
cd hybrid-llm-cache-gateway
```

### 2. Start Postgres + Redis

```bash
docker-compose up -d
```

### 3. Install gateway dependencies

```bash
cd gateway
npm install
```

### 4. Install ML service dependencies

```bash
cd ../ml-service
pip install -r requirements.txt
```

### 5. Create `.env` files

**`gateway/.env`**
```env
DATABASE_URL=postgresql://admin:password@localhost:5434/hybridcache
REDIS_URL=redis://localhost:6379
GROQ_API_KEY=your_groq_api_key
ML_SERVICE_URL=http://localhost:5050
```

### 6. Run database migrations

```bash
cd gateway
npx prisma migrate dev
```

### 7. Start the services

```bash
# Terminal 1 — ML service
cd ml-service
uvicorn embedder:app --port 5050

# Terminal 2 — Gateway
cd gateway
npm start
```

---

## 📡 API Endpoints

### Gateway — `/v1`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/query` | Submit a query — returns a cached response, a fresh LLM response, or a vetoed-then-LLM response, depending on the decision path |

### ML Service — internal

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/embed` | Returns a MiniLM-L6 embedding vector for the given text |
| `POST` | `/verify` | Returns NLI `{contradiction, entailment, neutral}` probabilities for a `{query, candidate}` pair |

---

## 🏗️ Architecture

### Decision Pipeline

```
1. Exact match check (Redis, MD5 hash)        → HIT, instant
2. Embed query (MiniLM-L6 via ml-service)
3. Semantic search (pgvector, top-1 candidate)
4. semantic_score < lowCutoff?                → LLM directly, skip verifier
5. Else: NLI verify (query, candidate)
6. contradiction >= nliThreshold?              → vetoed, call LLM
   else                                        → cache HIT
7. Log full decision to telemetry
```

### Why a veto, not a blend

Score distributions measured across a 255-pair labeled evaluation set show genuine paraphrases and genuine non-matches **fully overlap** in cosine similarity (positives: 0.489–0.969, negatives: up to 0.999) — there is no similarity threshold that is safe to auto-accept without a secondary check. A weighted blend of semantic + lexical scores was tried first and found structurally unable to separate the two, since trap pairs like "start/stop the server" share almost all their words by construction and score *higher* on lexical overlap than genuine reworded paraphrases. The veto architecture replaced it: a pretrained NLI model gates the decision instead of being blended into it. Full evidence and the investigation that led here: [`plan.md`](./plan.md).

### Config (Redis, hot-reloadable)

```json
{
  "mode": "veto",
  "lowCutoff": 0.6,
  "nliThreshold": 0.5,
  "baselineThreshold": 0.85
}
```

---

## 📊 Evaluation

Measured on a 57-query labeled traffic set, comparing pure semantic caching (Baseline) against SentryCache's veto architecture:

| | Baseline | SentryCache |
|---|---|---|
| Hit rate | 28% | 42% |
| False positives (of 8 trap pairs) | 2 | 1 |
| Paraphrase recall | 28% | 78% |

SentryCache beats the baseline on every measured axis — fewer wrong hits, nearly 3x the paraphrase recall, double the hit rate. A larger 255-pair offline study (not live traffic) found the NLI veto reduces wrong hits by ~97% relative to pure semantic matching with zero recall cost. Full methodology and findings: [`plan.md`](./plan.md).

---

## 🗂️ Project Structure

```
hybrid-llm-cache-gateway/
│
├── gateway/
│   ├── src/
│   │   ├── middleware/
│   │   │   ├── cacheMiddleware.js    # Orchestrates the full decision flow
│   │   │   ├── exactMatch.js         # Redis L1 exact match
│   │   │   ├── semanticSearch.js     # pgvector search + store
│   │   │   ├── verifier.js           # Calls ml-service /verify
│   │   │   ├── embedder.js           # Calls ml-service /embed
│   │   │   └── llm.js                # Groq API call on cache miss
│   │   ├── service/
│   │   │   ├── redis.js              # ioredis client + config
│   │   │   ├── telemetry.js          # Decision logging
│   │   │   └── prisma.js
│   │   └── config/
│   │       └── default.js            # Cold-start defaults
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── app.js
│   └── server.js
│
├── ml-service/
│   ├── embedder.py                   # FastAPI: /embed + /verify
│   └── requirements.txt
│
├── evaluation/
│   ├── query_set/                    # Labeled paraphrase/trap/unrelated pairs
│   ├── simulate_traffic.js
│   ├── run_eval.js
│   └── results/
│
├── demo-app/
├── docker-compose.yml
└── plan.md                           # Full development report
```

---

## ⚠️ Known Limitations

- **Same-topic, different-intent queries** (e.g. "check memory usage" vs "increase the memory limit") aren't logical contradictions, so the veto can't catch them — documented, not solved.
- **No automatic parameter tuning** — `lowCutoff`/`nliThreshold` are manually tuned from measured score distributions, not learned live. An earlier Bayesian auto-tuning approach was built and dropped (see `plan.md`).
- Full list and reasoning in [`plan.md`](./plan.md).

---

## 👤 Author

<div align="center">

**Dushyant Yadav**
B.Tech CSE (AI & Data Science)

[![GitHub](https://img.shields.io/badge/GitHub-Dushyant0608-181717?style=for-the-badge&logo=github)](https://github.com/Dushyant0608)

</div>

---

<div align="center">

Made with ❤️ by Dushyant Yadav

</div>