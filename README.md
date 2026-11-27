<div align="center">

# 🪣 BucketAPI

**A standalone rate limiting service your backend calls over HTTP.**  
No library imports. No in-process state. Just one HTTP call to get an ALLOW or DENY.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com)
[![k6](https://img.shields.io/badge/Load%20tested-500%20VUs-7D64FF?style=flat-square&logo=k6&logoColor=white)](https://k6.io)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

</div>

---

## The Problem

Every backend needs rate limiting. Most teams solve it by importing a library inside their own service — and it works fine until you scale:

- **Multiple instances** of your service each have their own counters → a client can multiply their quota by the number of pods you run.
- **Changing limits** requires a config change and a redeploy of every service that rate limits.
- **Telemetry is scattered** — every service logs its own denials with no central view.

BucketAPI fixes this by being the **single source of truth** for all token state. All your services call one endpoint. State lives in Redis. Limits change via one admin call, instantly.

---

## How It Works

```
Your Service                BucketAPI               Redis
    │                           │                      │
    │  POST /check               │                      │
    │  { client_key: "user_1" }  │                      │
    │ ─────────────────────────► │                      │
    │                           │  EVAL lua (atomic)   │
    │                           │ ────────────────────► │
    │                           │  { ALLOW, 14, reset } │
    │                           │ ◄──────────────────── │
    │  200 { decision: "ALLOW" } │                      │
    │ ◄───────────────────────── │                      │
    │                           │                      │
    │  (serve the request)       │                      │
```

BucketAPI never proxies traffic — it only makes decisions. Your service acts on the result.

---

## Features

| Feature | Details |
|---------|---------|
| **Token Bucket** | Lazy refill — tokens accumulate while idle, burst on demand |
| **Sliding Window** | Weighted blend of current + previous window, no boundary spikes |
| **Per-client config** | Set `rps` and `burst_size` per key via one admin call |
| **Atomic operations** | All state changes run in a single Redis `EVAL` — zero race conditions |
| **Persistent state** | Redis RDB + AOF — bucket state survives restarts, no free quota resets |
| **Standard headers** | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every response |
| **Load tested** | k6 script validates 500 concurrent VUs with correct ALLOW/DENY ratios |
| **Docker ready** | One command to start the whole stack with persistent Redis volume |

---

## Quick Start

```bash
git clone https://github.com/NamanBharsakale/BucketAPI.git
cd BucketAPI
cp .env.example .env
docker-compose up -d
```

```bash
curl http://localhost:3000/health
# {"status":"ok","redis":"connected"}
```

```bash
curl -X POST http://localhost:3000/check \
  -H "Content-Type: application/json" \
  -d '{"client_key": "user_123"}'
# {"decision":"ALLOW","remaining":19,"reset":1720000060}
```

That's it. Full setup guide → [`setup.md`](setup.md)

---

## API Reference

### `POST /check`

The core endpoint. Call this before serving any request you want to rate limit.

**Request**
```json
{ "client_key": "user_123" }
```

**Response — 200 ALLOW**
```json
{
  "decision": "ALLOW",
  "remaining": 14,
  "reset": 1720000060
}
```

**Response — 429 DENY**
```json
{
  "decision": "DENY",
  "remaining": 0,
  "reset": 1720000061
}
```

**Headers on every response**
```
X-RateLimit-Limit:     20
X-RateLimit-Remaining: 14
X-RateLimit-Reset:     1720000060
```

> `reset` is a Unix timestamp — the moment enough tokens will exist for the next request.

---

### `POST /admin/clients`

Configure per-client limits. All fields are optional — only send what you want to change.

**Request**
```json
{
  "client_key": "user_123",
  "algorithm": "token_bucket",
  "requests_per_second": 10,
  "burst_size": 15
}
```

| Field | Type | Description |
|-------|------|-------------|
| `client_key` | string | Required. The key to configure. |
| `algorithm` | `"token_bucket"` \| `"sliding_window"` | Which algorithm to use. Default: `token_bucket`. |
| `requests_per_second` | number > 0 | Token refill rate, or sliding-window request limit per second. Default: env `DEFAULT_RPS` (10). |
| `burst_size` | integer ≥ 1 | Token-bucket capacity; not used by sliding window. Default: env `DEFAULT_BURST` (20). |

**Response**
```json
{ "ok": true, "client_key": "user_123", "config": { "algorithm": "token_bucket", "rps": "10", "burst": "15" } }
```

---

### `GET /admin/clients/:key`

Inspect a client's current config and live token count. Useful for debugging.

```bash
curl http://localhost:3000/admin/clients/user_123
```

```json
{
  "client_key": "user_123",
  "config": {
    "algorithm": "token_bucket",
    "rps": "10",
    "burst": "15"
  },
  "live": {
    "tokens": 12.47,
    "last_refill": 1720000055123
  }
}
```

`live.tokens` is the real-time float token count — you can watch it refill between requests.

---

### `GET /health`

```bash
curl http://localhost:3000/health
# {"status":"ok","redis":"connected"}
```

Returns `503` if Redis is unreachable. Use this as your liveness probe.

---

## Algorithms

### Token Bucket

A bucket holds up to `burst_size` tokens. Tokens refill at `requests_per_second`. Each allowed request consumes one token.

```
Bucket: [■■■■■■■■■■■■■■□□□□□□]  (14/20 tokens)
         ↑ consumed              ↑ will refill at 10/s
```

- **ALLOW**: tokens ≥ 1 → deduct 1, return remaining count
- **DENY**: tokens < 1 → return time until next token arrives
- **Burst**: a quiet client accumulates tokens up to `burst_size`, then can spend them instantly

The refill happens lazily — no background timer. On every `/check` call, elapsed time × rate is added to the stored count, capped at burst.

**Redis state** — `bucket:{client_key}` hash:
```
tokens       → "12.47"         (float, decrements on use, refills over time)
last_refill  → "1720000055123" (unix ms, updated on every call)
```

---

### Sliding Window

Fixed windows have a boundary problem: requests near a window boundary can exceed the intended per-second rate. The sliding-window algorithm uses `requests_per_second` as its limit; `burst_size` does not apply.

The sliding window fixes this with a weighted blend:

```
weighted = prev_count × (1 − elapsed_fraction) + curr_count
```

If you're 30% into the current 1-second window, the previous window contributes 70% of its count. Requests are allowed while the weighted count is below `requests_per_second`. This approximates a true sliding window at O(1) cost.

**Redis state** — two string keys per client:
```
sw:{key}:{curr_window}  → "43"   TTL: 2 seconds
sw:{key}:{prev_window}  → "100"  TTL: 2 seconds (expires naturally)
```

Switch a client to sliding window:
```bash
curl -X POST http://localhost:3000/admin/clients \
  -H "Content-Type: application/json" \
  -d '{"client_key": "user_123", "algorithm": "sliding_window"}'
```

---

### Why Lua Scripts, Not Transactions?

Redis `MULTI/EXEC` queues commands but can't read values and make decisions inside the transaction. Without decisions, you can't compute the refill or check if tokens are available — you'd have to use `WATCH` (optimistic locking) and retry on conflict.

Lua scripts execute **atomically** inside Redis's single-threaded event loop. The entire read → calculate → write happens in one `EVAL` call. No other command can interleave. No retries needed.

```
Without Lua:
Thread A → GET tokens=5
Thread B → GET tokens=5     ← reads before A writes
Thread A → SET tokens=4     ← ALLOW
Thread B → SET tokens=4     ← ALLOW (double-spend!)

With Lua (EVAL):
Thread A → EVAL → read 5, compute 4, write 4, return ALLOW
Thread B → EVAL → read 4, compute 3, write 3, return ALLOW ✓
```

---

## Load Testing

The repo ships with a [k6](https://k6.io) load test script that validates correctness under concurrency.

```bash
k6 run scripts/loadtest.js
```

What it does:
1. Configures a test client with `rps=100`, `burst=100`
2. Launches **500 virtual users** hammering `/check` for 10 seconds
3. Counts total ALLOWs — must be ≤ 1000 (100/s × 10s) + 5% tolerance
4. Asserts **p99 latency < 10ms**
5. Fails if any double-spends are detected

Sample output:
```
=== BucketAPI Load Test Summary ===
Total requests : 48,241
ALLOWs         : 1,003
DENYs          : 47,238
Expected ALLOWs: ~1000 (100/s × 10s)
Allow rate     : 2.1%
PASS: ALLOW count within expected range (no double-spend)
```

Test against a remote server:
```bash
BASE_URL=https://your-deployed-url k6 run scripts/loadtest.js
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string. Use `rediss://` for TLS. |
| `PORT` | `3000` | HTTP port. |
| `DEFAULT_RPS` | `10` | Requests per second for clients with no config set. |
| `DEFAULT_BURST` | `20` | Burst size for clients with no config set. |

Copy `.env.example` to `.env` and adjust as needed.

---

## Project Structure

```
BucketAPI/
├── src/
│   ├── index.js              # Express app, middleware, route mounting
│   ├── redis.js              # ioredis singleton client
│   ├── routes/
│   │   ├── check.js          # POST /check — algorithm dispatch + headers
│   │   └── admin.js          # POST /admin/clients, GET /admin/clients/:key
│   └── algorithms/
│       ├── tokenBucket.js    # Lua script + redis.eval wrapper
│       └── slidingWindow.js  # Lua script + redis.eval wrapper
├── scripts/
│   └── loadtest.js           # k6 load test, run with: k6 run scripts/loadtest.js
├── Dockerfile                # Multi-stage build, non-root user
├── docker-compose.yml        # App + Redis with persistent named volume
├── redis.conf                # RDB + AOF persistence config
├── .env.example              # Environment variable template
├── setup.md                  # Local development guide
└── deployment.md             # Railway + VPS deployment guide
```

---

## Redis Key Schema

| Key | Type | Fields / Value |
|-----|------|----------------|
| `bucket:{client_key}` | Hash | `tokens` (float), `last_refill` (unix ms) |
| `config:{client_key}` | Hash | `algorithm`, `rps`, `burst` |
| `sw:{client_key}:{window}` | String | Request count, TTL = 2 × window size |

---

## Docs

| Guide | Description |
|-------|-------------|
| [`setup.md`](setup.md) | Local setup: Docker Compose, native Node.js, Redis CLI inspection, load test |
| [`deployment.md`](deployment.md) | Deploy to Railway or a Linux VPS with Nginx + HTTPS |

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 20 | Async I/O, large ecosystem |
| Framework | Express 4 | Minimal, mature, no magic |
| State | Redis 7 | Atomic Lua scripts, sub-ms latency, built-in TTL |
| Redis client | ioredis | Clean `.eval()` API, automatic reconnect |
| Load test | k6 | Scriptable, real percentile metrics |
| Deploy | Docker + Railway | Reproducible, persistent volumes |

---

<div align="center">

Built to demonstrate **networked rate limiting**, **Redis atomicity**, and **concurrent system design**.

</div>
