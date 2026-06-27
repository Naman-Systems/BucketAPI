# BucketAPI

A standalone rate limiting service. Other backend services call it over HTTP to get an ALLOW or DENY decision. Built with Token Bucket and Sliding Window algorithms, Redis-backed persistent state, and Lua scripts for atomicity.

## Quick Start

```bash
cp .env.example .env
docker-compose up -d
```

App on `http://localhost:3000`. Redis on `localhost:6379`.

## API

### POST /check

Returns ALLOW or DENY for a client key.

```bash
curl -X POST http://localhost:3000/check \
  -H "Content-Type: application/json" \
  -d '{"client_key": "user_abc"}'
```

200 (ALLOW):
```json
{ "decision": "ALLOW", "remaining": 14, "reset": 1720000060 }
```

429 (DENY):
```json
{ "decision": "DENY", "remaining": 0, "reset": 1720000060 }
```

Headers on every response:
```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 14
X-RateLimit-Reset: 1720000060
```

### POST /admin/clients

Configure per-client limits.

```bash
curl -X POST http://localhost:3000/admin/clients \
  -H "Content-Type: application/json" \
  -d '{
    "client_key": "user_abc",
    "algorithm": "token_bucket",
    "requests_per_second": 10,
    "burst_size": 15
  }'
```

`algorithm` can be `token_bucket` (default) or `sliding_window`.

### GET /admin/clients/:key

Get current config and live token count.

```bash
curl http://localhost:3000/admin/clients/user_abc
```

```json
{
  "client_key": "user_abc",
  "config": { "algorithm": "token_bucket", "rps": "10", "burst": "15" },
  "live": { "tokens": 14.2, "last_refill": 1720000055123 }
}
```

### GET /health

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "redis": "connected" }
```

## Load Test

Requires [k6](https://k6.io/docs/getting-started/installation/).

```bash
k6 run scripts/loadtest.js
```

Tests 500 virtual users against a single client key. Validates:
- p99 latency < 10ms
- No double-spend under concurrent load
- Correct ALLOW/DENY ratios

Override target URL:
```bash
BASE_URL=http://your-host:3000 k6 run scripts/loadtest.js
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `PORT` | `3000` | HTTP port |
| `DEFAULT_RPS` | `10` | Requests per second for unconfigured clients |
| `DEFAULT_BURST` | `20` | Burst size for unconfigured clients |

## How It Works

### Token Bucket

State stored in Redis hash `bucket:{client_key}` with fields `tokens` (float) and `last_refill` (unix ms). On every `/check` call, a single Lua script atomically:

1. Reads tokens + last_refill
2. Refills based on elapsed time: `tokens += elapsed_seconds × rate`
3. Caps at burst_size
4. Deducts 1 if available → ALLOW, else → DENY
5. Writes back

One `EVAL` call = no race condition possible.

### Sliding Window

Uses two counters per client: current window and previous window. Weighted count blends them:

```
weighted = prev_count × (1 - elapsed_fraction) + curr_count
```

If weighted < limit → ALLOW. Smoother than fixed windows at boundaries.

### Why Lua and not MULTI/EXEC?

Redis `MULTI/EXEC` (transactions) don't let you read a value and make decisions inside the transaction — you queue commands blindly. Lua scripts execute atomically with full read/write access, so the refill calculation and deduction happen in one uninterruptible step.

## Deploy to Railway

1. Push to GitHub
2. New project → Deploy from repo
3. Add Redis plugin
4. Set env vars: `REDIS_URL` (Railway provides this), `PORT`
5. Done — Railway auto-provisions persistent volume for Redis
