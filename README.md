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

SentryCache is a semantic caching gateway for LLM APIs that fixes the biggest failure mode in similarity-based caching: topically similar but logically opposite queries (e.g. "start the server" vs "stop the server") score 0.94+ cosine similarity despite needing opposite answers. SentryCache adds a **contradiction veto** — every semantic match above a low-confidence cutoff is checked by a pretrained NLI model before it's allowed to serve as a cache hit.

```
Client → Express Gateway → Redis (exact match) → pgvector (semantic search) → NLI Verifier (veto) → Cache HIT or LLM call
```

---

## 🏆 Results

Benchmarked against **GPTCache** (the standard open-source semantic caching library) on the same 255-pair labeled dataset, same embedding model, matched recall:

| System | Recall | Wrong Hits (of 190 trap pairs) | Wrong Hit Rate |
|---|---|---|---|
| GPTCache (default) | 93.9% | 139 | 73.2% |
| GPTCache / Baseline (matched recall) | 83.1% | 122 | 64.2% |
| **SentryCache (NLI Veto)** | **83.1%** | **4** | **2.1%** |

**~97% fewer wrong cache hits than pure semantic matching, at zero recall cost** — and this advantage holds across every threshold GPTCache could be tuned to, not just one cherry-picked point.

Live deployment results (57-query traffic, vs. pure semantic baseline):

| Metric | Baseline | SentryCache |
|---|---|---|
| Hit rate | 28% | 42% |
| Paraphrase recall | 28% | 78% |
| False positives (8 trap pairs) | 2 | 1 |

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 🛡️ **NLI Contradiction Veto** | Every borderline semantic match is checked by `cross-encoder/nli-deberta-v3-small` before being served — catches false positives similarity scores can't |
| 🎯 **Two-Zone Decision Architecture** | No similarity score is ever auto-trusted; score distributions for matches and non-matches fully overlap, so every borderline match is verified |
| ⚡ **Local Embeddings** | MiniLM-L6 runs locally via FastAPI — no per-query embedding API cost or latency |
| 🔄 **Hot-Reloadable Config** | Thresholds live in Redis, tunable in production with zero downtime |
| 🗄️ **Two-Tier Cache** | Redis for exact-match (L1), PostgreSQL + pgvector for semantic search (L2) — nothing lost on eviction |
| 📊 **Full Decision Telemetry** | Every request logs its score path for auditability |

---

## 🛠️ Tech Stack

**Gateway:** Node.js, Express.js
**ML Service:** Python, FastAPI, `sentence-transformers`, PyTorch
**Database:** PostgreSQL + `pgvector`, Prisma ORM
**Cache:** Redis (`ioredis`)
**LLM:** Groq API

---

## 🚀 Quick Start

```bash
git clone https://github.com/Dushyant0608/hybrid-llm-cache-gateway
cd hybrid-llm-cache-gateway

# Start Postgres + Redis
docker-compose up -d

# Gateway
cd gateway && npm install

# ML service
cd ../ml-service && pip install -r requirements.txt
```

Create `gateway/.env`:
```env
DATABASE_URL=postgresql://admin:password@localhost:5434/hybridcache
REDIS_URL=redis://localhost:6379
GROQ_API_KEY=your_groq_api_key
ML_SERVICE_URL=http://localhost:5050
```

```bash
cd gateway && npx prisma migrate dev

# Terminal 1
cd ml-service && uvicorn embedder:app --port 5050

# Terminal 2
cd gateway && npm start
```

---

## 📡 API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/query` | Submit a query — returns cached, fresh LLM, or vetoed-then-LLM response |
| `POST` | `/embed` (internal) | MiniLM-L6 embedding for text |
| `POST` | `/verify` (internal) | NLI `{contradiction, entailment, neutral}` scores for a pair |

### Decision Pipeline
```
1. Exact match (Redis, MD5 hash)           → HIT, instant
2. Embed query (MiniLM-L6)
3. Semantic search (pgvector, top-1)
4. score < lowCutoff?                       → LLM directly
5. Else: NLI verify (query, candidate)
6. contradiction >= nliThreshold?            → vetoed, call LLM
   else                                      → cache HIT
```

---

## ⚠️ Known Limitations

- Same-topic, different-intent queries (e.g. "check memory usage" vs "increase memory limit") aren't logical contradictions, so the veto can't catch them.
- Thresholds are manually tuned from measured score distributions, not auto-tuned live.

Full methodology, evaluation design, and development history: see the project report.

---

## 👤 Author

<div align="center">

**Dushyant Yadav**
B.Tech CSE (AI & Data Science), IIIT Manipur

[![GitHub](https://img.shields.io/badge/GitHub-Dushyant0608-181717?style=for-the-badge&logo=github)](https://github.com/Dushyant0608)

</div>