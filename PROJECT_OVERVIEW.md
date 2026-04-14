# SentinelTruth — Complete Project Overview

> **One file to understand the entire project.**  
> Malaysian Political Fact-Checker powered by AI — real-time analysis, multi-language support, and transparent verification.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (Vite + Vanilla JS)              │
│  ┌──────────┐  ┌────────┐  ┌──────────┐  ┌──────────────┐  │
│  │Dashboard │  │Topics  │  │Statistics│  │  AI Agent UI │  │
│  └────┬─────┘  └───┬────┘  └────┬─────┘  └──────┬───────┘  │
│       │            │            │               │           │
│       └────────────┴────────────┴───────────────┘           │
│                         │  SSE + REST API                   │
├─────────────────────────┼───────────────────────────────────┤
│                    Server (Node.js + Express)                │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────────────┐  │
│  │  Router  │  │ Data Mgr   │  │      AI Agent           │  │
│  │ (index)  │  │ (JSON file)│  │  Search→Analyze→Translate│  │
│  └──────────┘  └────────────┘  └────────┬────────────────┘  │
│                                         │                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┴────────────────┐  │
│  │  Source   │  │  Source  │  │    AI Provider Chain      │  │
│  │Collector │  │ Verifier │  │ Groq → Ollama → HuggingFace│ │
│  └──────────┘  └──────────┘  └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Technology Stack
| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla JS + CSS | Dashboard, Topics, Statistics, Agent UI |
| Build | Vite 6 | Dev server + production bundling |
| Server | Express 4 | REST API + SSE streaming |
| AI (Primary) | Groq API (Llama 3.3 70B) | Fast, free-tier fact-checking + translation |
| AI (Local) | Ollama (qwen2.5:32b) | Local/self-hosted fallback |
| AI (Cloud) | HuggingFace Inference | Cloud fallback when Groq is rate-limited |
| Charts | Chart.js 4 | Statistical visualizations |
| XML Parsing | fast-xml-parser 5 | RSS/Atom feed parsing |
| i18n | Custom translation module | EN, BM, Hindi, Chinese |

---

## 📁 File Map

### Server (`server/`)

| File | Size | Purpose |
|------|------|---------|
| `index.js` | 9KB | Express server, routes, SSE, startup |
| `services/ai-agent.js` | 24KB | **Core pipeline**: Search → Analyze → Translate (deferred) → Store → Broadcast |
| `services/data-manager.js` | 16KB | JSON file persistence, dedup, filtering, stats (with debounced writes + caching) |
| `services/groq-analyzer.js` | 7KB | Groq Llama 3.3 70B integration (with response cache) |
| `services/ollama-analyzer.js` | 6KB | Local Ollama integration (with response cache + health checks) |
| `services/huggingface-fallback.js` | 5KB | HuggingFace Inference fallback (multi-model) |
| `services/source-collector.js` | 16KB | RSS feeds, Google News, Facebook Graph API collection |
| `services/source-verifier.js` | 7KB | Rule-based source authenticity scoring (0-100) |
| `services/shared-constants.js` | 5KB | **Shared**: signal terms, pre-compiled regex, LRU cache, helpers |
| `data/topics.json` | varies | Persisted topics data |
| `data/agent-log.json` | varies | Agent activity log |
| `scripts/ingest-real.js` | 1KB | CLI: bulk ingest real articles |
| `scripts/setup-turso.js` | 7KB | CLI: setup Turso (libSQL) database |

### Frontend (`src/`)

| File | Size | Purpose |
|------|------|---------|
| `main.js` | 75KB | **Core SPA**: Dashboard, Topics, Parties, Statistics, Agent views |
| `styles/main.css` | 58KB | Full design system + responsive styles |
| `i18n/translations.js` | 35KB | 4-language translation table (EN, BM, Hindi, Chinese) |
| `data/parties.js` | 5KB | Party definitions, colors, coalitions, verdicts |
| `data/seed-data.js` | 29KB | Initial seed topics for demo |
| `services/ai-agent.js` | 8KB | Client-side agent simulation (legacy, overridden by server SSE) |
| `services/data-store.js` | 6KB | localStorage persistence (legacy, server is source of truth) |
| `utils/helpers.js` | 4KB | Date formatting, debounce, DOM helpers |

### Root

| File | Purpose |
|------|---------|
| `index.html` | HTML shell with nav, modal, toast container |
| `package.json` | Dependencies and npm scripts |
| `vite.config.js` | Vite build configuration |
| `render.yaml` | Render.com deployment config |
| `.env` | Environment variables (API keys, model config) |

---

## 🔄 Data Flow

### 1. Discovery Pipeline
```
RSS Feeds + Google News (165+ queries)
         │
         ▼
    Source Collector (8 parallel workers)
         │
         ▼
    Malaysia Political Filter (party + political signal matching)
         │
         ▼
    Dedup by URL + normalized title
         │
         ▼
    Queue (up to 15 topics per search cycle)
```

### 2. Analysis Pipeline
```
Queue → Pick batch (default: 1 per cycle)
         │
         ▼
    Try Groq (Llama 3.3 70B, 25 RPM limit)
    ├── Success → verdict + analysis + party + category
    │
    ├── Rate limited → Try Ollama (local, qwen2.5:32b)
    │   ├── Success → verdict + analysis
    │   └── Failed → Try HuggingFace (Qwen 72B/32B/8B)
    │
    └── All failed → Heuristic fallback (keyword-based, verdict: UNVERIFIED)
         │
         ▼
    Store topic (dedup check, JSON persistence)
         │
         ▼
    Broadcast via SSE to all connected clients
```

### 3. Translation Pipeline (Deferred)
```
Every 60 seconds:
    Scan stored topics → filter untranslated
         │
         ▼
    Batch 3 topics in parallel
         │
         ▼
    Translate to BM + Hindi + Chinese
    (via Groq or Ollama, with LRU caching)
         │
         ▼
    Merge translations into topic record
```

### 4. Bulk Ingestion Pipeline
```
POST /api/ingest/run { targetCount: 1000 }
         │
         ▼
    Source Collector (RSS + Google News + Facebook)
         │
         ▼
    Source Verifier (rule-based scoring, 0-100)
    ├── ≥80 → VERIFIED
    ├── ≥65 → LIKELY_REAL (accepted)
    ├── ≥50 → WEAK (rejected)
    └── <50 → REJECTED
         │
         ▼
    Bulk storage (single disk write)
```

---

## 🌐 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health + uptime + topic count |
| GET | `/api/ping` | Simple connectivity check |
| GET | `/api/progress` | SSE stream (status, action, newTopic, ingestionReport) |
| GET | `/api/topics` | List topics (query: party, verdict, category, search, limit) |
| GET | `/api/topics/:id` | Single topic by ID |
| POST | `/api/topics/backfill-translations` | Trigger translation backfill (body: { limit }) |
| GET | `/api/stats` | Aggregated statistics (verdict, party, category, monthly) |
| GET | `/api/data-quality` | Data quality metrics (real vs synthetic, verification) |
| GET | `/api/agent/status` | Agent status + provider info |
| POST | `/api/agent/start` | Start the AI agent |
| POST | `/api/agent/pause` | Pause the AI agent |
| POST | `/api/agent/stop` | Stop the AI agent |
| GET | `/api/agent/log` | Activity log (query: limit) |
| POST | `/api/agent/log/clear` | Clear activity log |
| POST | `/api/agent/reset` | Reset all data (requires ENABLE_AGENT_RESET=true) |
| POST | `/api/ingest/run` | Bulk ingest (body: { targetCount, includeInternet, includeFacebook }) |
| GET | `/api/providers` | Provider status (Groq, Ollama, HuggingFace) |

---

## ⚙️ Environment Variables

### API Keys (all free)
| Variable | Required | Source |
|----------|----------|--------|
| `GROQ_API_KEY` | Recommended | https://console.groq.com → API Keys |
| `HF_API_TOKEN` | Optional | https://huggingface.co → Settings → Access Tokens |
| `FACEBOOK_ACCESS_TOKEN` | Optional | Facebook Graph API (for social media collection) |

### Ollama (Local AI)
| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_ENABLED` | `true` | Enable local Ollama integration |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen2.5:32b` | Model to use (see recommendations below) |
| `OLLAMA_TIMEOUT_MS` | `30000` | Request timeout in ms |

### Model Recommendations
| Model | Speed | Quality | RAM | Best For |
|-------|-------|---------|-----|----------|
| `qwen2.5:72b` | ⭐⭐ | ⭐⭐⭐⭐⭐ | 48GB | Best quality, slow |
| `qwen2.5:32b` | ⭐⭐⭐ | ⭐⭐⭐⭐ | 20GB | **Recommended** — best balance |
| `qwen2.5:14b` | ⭐⭐⭐⭐ | ⭐⭐⭐ | 10GB | Fast with good quality |
| `llama3.1:8b` | ⭐⭐⭐⭐⭐ | ⭐⭐ | 5GB | Fastest, basic quality |

### Agent Settings
| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_AUTO_START` | `true` | Auto-start agent on server boot |
| `SEARCH_INTERVAL_MS` | `1800000` | Feed search cycle (30 min) |
| `ANALYZE_INTERVAL_MS` | `20000` | Analysis cycle (20 sec) |
| `ANALYZE_BATCH_SIZE` | `1` | Topics per analysis cycle |
| `ALLOW_SIMULATED_DATA` | `true` | Allow demo data when no API keys |

### Data Quality
| Variable | Default | Description |
|----------|---------|-------------|
| `STRICT_REAL_MODE` | `false` | Only show verified real records |
| `VERIFICATION_MIN_SCORE` | `65` | Min source verification score |
| `MALAYSIA_POLITICS_ONLY` | `true` | Filter to Malaysian political content only |

---

## 🚀 Performance Optimizations

### Server-side
1. **LRU Response Caching** — Groq + Ollama results cached (200 entries, 30min TTL for analysis, 1hr for translations)
2. **Ollama Health Checks** — Quick 3s ping every 60s to skip requests when server is down
3. **Debounced Disk Writes** — 2s coalesce window: 1000 bulk topics = 1 disk write (was 1000)
4. **URL Index** — O(1) duplicate checking via Set (was O(n) linear scan)
5. **Stats Caching** — 10s TTL for computed statistics (avoids re-iterating all topics)
6. **Deferred Translation** — Separate 60s cycle with 3-topic parallel batches (was blocking analysis)
7. **Pre-compiled Regex** — Signal matching regex compiled once at load (was per-call)
8. **Shared Constants** — Eliminated duplication across 3 files into one module
9. **Token Limits** — `num_predict: 800` for analysis, `1200` for translation (prevents runaway generation)
10. **Lower Temperature** — `0.15` for Ollama, `0.2` for Groq (faster + more deterministic)

### Client-side
1. **API Response Cache** — 5s TTL client-side cache for GET requests
2. **SSE Render Debounce** — 500ms coalesce for rapid newTopic events
3. **Single API Call** — Topics page fetches once (was 2 parallel calls)
4. **Lazy Translation Backfill** — Limit 20 (was 80) on language switch

---

## 🏃 Running the Project

```bash
# Development (server + Vite)
npm run dev          # Start Express server on port 3000
npm run dev:vite     # Start Vite dev server (optional, for HMR)

# Production
npm run build        # Build frontend with Vite
npm start            # Start production server

# Data operations
npm run ingest:real           # Bulk ingest 1000 real articles
npm run db:turso:setup        # Setup Turso database
npm run db:turso:schema       # Setup schema only
```

---

## 🌍 Multi-Language Support

### Static UI Labels
- Defined in `src/i18n/translations.js` — 4 languages × ~170 keys each
- Language switcher in navbar updates `localStorage` + re-renders all sections

### Dynamic Topic Content
- Translated by AI (Groq/Ollama) via the deferred translation cycle
- Stored per-topic in `translations: { ms: {...}, hi: {...}, zh: {...} }`
- Backfill endpoint `/api/topics/backfill-translations` for existing records

### Supported Languages
| Code | Language | Flag |
|------|----------|------|
| `en` | English | 🇬🇧 |
| `ms` | Bahasa Melayu | 🇲🇾 |
| `hi` | हिन्दी (Hindi) | 🇮🇳 |
| `zh` | 中文 (Chinese) | 🇨🇳 |

---

## 🏛️ Political Parties Tracked

| Party | Coalition | Status | Color |
|-------|-----------|--------|-------|
| PKR | Pakatan Harapan (PH) | Ruling | Blue |
| DAP | Pakatan Harapan (PH) | Ruling | Red |
| AMANAH | Pakatan Harapan (PH) | Ruling | Orange |
| UMNO | Barisan Nasional (BN) | Ruling (Partner) | Red-dark |
| PAS | Perikatan Nasional (PN) | Opposition | Green |
| BERSATU | Perikatan Nasional (PN) | Opposition | Dark Blue |
| GPS | Gabungan Parti Sarawak | Ruling (Partner) | Teal |
| MUDA | Independent | Independent | Yellow |

---

## 📊 Verdict System

| Verdict | Icon | Meaning |
|---------|------|---------|
| TRUE | ✅ | Verified as factually accurate |
| HOAX | ❌ | Identified as false or fabricated |
| MISLEADING | ⚠️ | Contains truth but creates false impression |
| PARTIALLY_TRUE | 🟡 | Part accurate, part missing/exaggerated |
| UNVERIFIED | ❓ | Insufficient evidence to determine |

---

## 🔐 Source Verification Scoring

The `source-verifier.js` scores each record 0-100 based on:

| Factor | Points | Description |
|--------|--------|-------------|
| Has title (≥15 chars) | +10 | Basic content check |
| Has summary (≥50 chars) | +10 | Meaningful description |
| Has source URL | +12 | Traceable back to source |
| Has publish date | +8 | Temporal context |
| Trusted domain (high) | +30 | bernama.com, thestar.com.my, etc. |
| Trusted domain (medium) | +18 | sinchew.com.my, utusan.com.my, etc. |
| Internet source | +8 | Web-sourced (vs. synthetic) |
| Multi-source corroboration | +18 | Same story from 2+ domains |
| Suspicious language | -25 | "guaranteed profit", "click here now" |
| No evidence metadata | -10 | Missing provenance data |

**Thresholds**: ≥80 VERIFIED, ≥65 LIKELY_REAL, ≥50 WEAK, <50 REJECTED
