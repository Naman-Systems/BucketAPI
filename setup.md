# Local Setup Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 (LTS) | https://nodejs.org |
| Docker | ≥ 24 | https://docs.docker.com/get-docker/ |
| Docker Compose | ≥ 2.x (bundled with Docker Desktop) | — |
| k6 _(optional, for load test)_ | latest | https://k6.io/docs/get-started/installation/ |

---

## Option A — Docker (recommended, zero config)

Everything runs inside containers. Redis state persists across restarts via a named Docker volume.

**1. Clone and configure**

```bash
git clone https://github.com/NamanBharsakale/BucketAPI.git
cd BucketAPI
cp .env.example .env
```

The defaults work as-is for local development. Docker Compose overrides `REDIS_URL`
inside the app container to use the `redis` service; the `localhost` URL in `.env`
remains suitable when running Node.js directly.

**2. Start**

```bash
docker compose up -d
```

This builds the app image, starts Redis 7 with persistence enabled, and waits for Redis to pass its health check before starting the app.

**3. Verify**

```bash
curl http://localhost:3000/health
# {"status":"ok","redis":"connected"}
```

**4. Stop**

```bash
docker compose down         # stops containers, keeps Redis data
docker compose down -v      # stops containers AND deletes Redis data
```

**View logs**

```bash
docker compose logs -f app    # app logs
docker compose logs -f redis  # redis logs
```

---

## Option B — Run directly (Node.js + local Redis)

Use this if you want to run the app natively (faster restart, easier debugging).

**1. Install Redis locally**

```bash
# macOS
brew install redis && brew services start redis

# Ubuntu / Debian
sudo apt install redis-server && sudo systemctl start redis

# Windows
# Use WSL2 and follow the Ubuntu steps, or use Redis on Docker just for Redis:
docker run -d -p 127.0.0.1:6379:6379 redis:7-alpine
```

**2. Clone and install**

```bash
git clone https://github.com/NamanBharsakale/BucketAPI.git
cd BucketAPI
npm install
cp .env.example .env
```

**3. Start**

```bash
npm run dev     # auto-restarts on file changes (uses nodemon)
# or
npm start       # production-style start
```

**4. Verify**

```bash
curl http://localhost:3000/health
# {"status":"ok","redis":"connected"}
```

---

## Using the API

### Check if a request is allowed

```bash
curl -X POST http://localhost:3000/check \
  -H "Content-Type: application/json" \
  -d '{"client_key": "user_abc"}'
```

First call — bucket starts full, returns ALLOW:
```json
{"decision":"ALLOW","remaining":19,"reset":1720000060}
```

Headers on every response:
```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 19
X-RateLimit-Reset: 1720000060
```

After exhausting the burst (hit it 20+ times quickly):
```json
{"decision":"DENY","remaining":0,"reset":1720000061}
```
HTTP status will be `429 Too Many Requests`.

---

### Set per-client limits

```bash
curl -X POST http://localhost:3000/admin/clients \
  -H "Content-Type: application/json" \
  -d '{
    "client_key": "user_abc",
    "algorithm": "token_bucket",
    "requests_per_second": 5,
    "burst_size": 10
  }'
```

Response:
```json
{"ok":true,"client_key":"user_abc","config":{"algorithm":"token_bucket","rps":"5","burst":"10"}}
```

Fields are all optional — only send what you want to change. Unset fields keep their current values.
For `sliding_window`, `requests_per_second` is the request limit per second; `burst_size` applies only to `token_bucket`.

**Switch a client to sliding window:**
```bash
curl -X POST http://localhost:3000/admin/clients \
  -H "Content-Type: application/json" \
  -d '{"client_key": "user_abc", "algorithm": "sliding_window"}'
```

---

### Inspect a client's current state

```bash
curl http://localhost:3000/admin/clients/user_abc
```

```json
{
  "client_key": "user_abc",
  "config": {
    "algorithm": "token_bucket",
    "rps": "5",
    "burst": "10"
  },
  "live": {
    "tokens": 7.42,
    "last_refill": 1720000055123
  }
}
```

`live.tokens` is the current float token count. `live.last_refill` is when the last refill calculation ran (unix ms).

---

### Inspect Redis directly

If you need to look at raw Redis state:

```bash
# Docker setup
docker-compose exec redis redis-cli

# Local Redis
redis-cli
```

Useful commands:
```
HGETALL bucket:user_abc        # current bucket state
HGETALL config:user_abc        # client config
GET sw:user_abc:1720000        # sliding window current counter
KEYS bucket:*                  # list all active client buckets
```

---

## Run the Load Test

Requires k6 installed. The load test spins up 500 virtual users, hammers `/check` for 10 seconds, and validates that no double-spends occurred.

**Start the server first (Docker or native), then:**

```bash
k6 run scripts/loadtest.js
```

Expected output:
```
=== BucketAPI Load Test Summary ===
Total requests : 47382
ALLOWs         : 1001
DENYs          : 46381
Expected ALLOWs: ~1000 (100/s × 10s)
Allow rate     : 2.1%
PASS: ALLOW count within expected range (no double-spend)
```

Run against a remote server:
```bash
BASE_URL=http://your-server:3000 k6 run scripts/loadtest.js
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string. Use `rediss://` for TLS. |
| `PORT` | `3000` | HTTP port the app listens on. |
| `DEFAULT_RPS` | `10` | Requests per second for clients with no config. |
| `DEFAULT_BURST` | `20` | Burst size for clients with no config. |

---

## Common Issues

**`ECONNREFUSED 127.0.0.1:6379`**
Redis isn't running. Start it with `docker-compose up -d redis` or `brew services start redis`.

**`/check` returns 500**
Check `/health` — if Redis shows disconnected, check your `REDIS_URL` in `.env`.

**Tokens not refilling as expected**
Check the client config: `GET /admin/clients/{key}`. Confirm `rps` and `burst` are what you expect. Note that `tokens` is a float — at very low RPS (e.g., 0.1/s), it refills slowly.

**All requests returning ALLOW even after limit**
The burst bucket is being shared with a different algorithm namespace. If you switched algorithms (e.g., from `token_bucket` to `sliding_window`), the old bucket state is still in Redis under a different key. The new algorithm starts fresh.
