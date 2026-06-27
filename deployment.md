# Deployment Guide

Two options covered: **Railway** (managed, push-to-deploy) and **any Linux VPS** (Docker Compose on a server you control).

---

## Option 1 — Railway (recommended for quick deploy)

Railway auto-detects the Dockerfile, provisions managed Redis with a persistent volume, and wires the `REDIS_URL` env var automatically.

### Steps

**1. Push your code to GitHub**

The repo must be on GitHub (or GitLab). Railway deploys from the repo.

**2. Create a Railway account**

Sign up at https://railway.app (free tier available).

**3. New project → Deploy from GitHub repo**

- Click **New Project**
- Select **Deploy from GitHub Repo**
- Pick `BucketAPI`
- Railway detects the Dockerfile and starts building

**4. Add Redis**

In the Railway project dashboard:
- Click **New** → **Database** → **Add Redis**
- Railway provisions a Redis 7 instance with a persistent volume
- It automatically injects `REDIS_URL` as an environment variable into your app service

**5. Set environment variables**

In your app service settings → **Variables**, add:

```
PORT=3000
DEFAULT_RPS=10
DEFAULT_BURST=20
```

`REDIS_URL` is already injected by Railway — do not set it manually.

**6. Deploy**

Railway deploys automatically on every push to `main`. For a manual deploy, click **Deploy** in the dashboard.

**7. Get your public URL**

In the app service → **Settings** → **Networking**, enable a public domain. Railway gives you a URL like `https://bucketapi-production.up.railway.app`.

**8. Verify**

```bash
curl https://your-app.up.railway.app/health
# {"status":"ok","redis":"connected"}
```

### Railway Notes

- Redis data lives on Railway's managed persistent volume — survives deploys and restarts
- Scale by adding more app replicas in Railway dashboard (Redis is shared, state stays consistent)
- Free tier has 500 execution hours/month and sleeps after inactivity — use a paid plan for always-on

---

## Option 2 — Linux VPS with Docker Compose

Works on any server that can run Docker: DigitalOcean Droplet, Hetzner, AWS EC2, etc.

### Server Prerequisites

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # add your user to docker group
newgrp docker                   # apply group change in current session

# Verify
docker --version
docker compose version
```

### Deploy Steps

**1. Copy the project to the server**

Option A — clone directly on the server:
```bash
git clone https://github.com/NamanBharsakale/BucketAPI.git
cd BucketAPI
```

Option B — rsync from your machine:
```bash
rsync -avz --exclude node_modules --exclude .env \
  /path/to/BucketAPI/ user@your-server:/opt/bucketapi/
```

**2. Create `.env`**

```bash
cp .env.example .env
nano .env
```

Set these values:
```
REDIS_URL=redis://redis:6379
PORT=3000
DEFAULT_RPS=10
DEFAULT_BURST=20
```

`REDIS_URL` must use the Docker service name `redis` (not `localhost`) because the app container resolves Redis by service name inside the Docker network.

**3. Start**

```bash
docker compose up -d --build
```

`--build` forces a fresh image build. Drop it on subsequent deploys if you want to use the cached image.

**4. Verify**

```bash
curl http://localhost:3000/health
# {"status":"ok","redis":"connected"}
```

**5. Check logs**

```bash
docker compose logs -f
```

### Expose to the Internet with Nginx

The app listens on `localhost:3000`. Put Nginx in front to handle HTTPS and a public domain.

**Install Nginx and Certbot:**
```bash
sudo apt install nginx certbot python3-certbot-nginx
```

**Create Nginx config** at `/etc/nginx/sites-available/bucketapi`:
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Enable and get HTTPS:**
```bash
sudo ln -s /etc/nginx/sites-available/bucketapi /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com
```

Certbot automatically modifies the Nginx config to redirect HTTP → HTTPS and adds the SSL certificate.

**Verify HTTPS:**
```bash
curl https://api.yourdomain.com/health
```

### Updates

When you push changes to GitHub, pull and redeploy on the server:

```bash
git pull
docker compose up -d --build
```

Zero downtime: Docker Compose brings up the new container, waits for the health check, then replaces the old one.

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection string. Use `redis://redis:6379` in Docker Compose; Railway injects this automatically. Use `rediss://host:6380` for TLS. |
| `PORT` | No (default: 3000) | Port the HTTP server listens on. |
| `DEFAULT_RPS` | No (default: 10) | Requests per second applied to clients with no config. |
| `DEFAULT_BURST` | No (default: 20) | Burst size applied to clients with no config. |

---

## Testing the Deployed Service

Replace `BASE_URL` with your actual deployed URL.

**Health check:**
```bash
curl https://your-deployed-url/health
```

**Basic rate limit check:**
```bash
curl -X POST https://your-deployed-url/check \
  -H "Content-Type: application/json" \
  -d '{"client_key": "smoke_test"}'
```

**Configure a client:**
```bash
curl -X POST https://your-deployed-url/admin/clients \
  -H "Content-Type: application/json" \
  -d '{
    "client_key": "smoke_test",
    "requests_per_second": 2,
    "burst_size": 5
  }'
```

**Confirm rate limiting fires (run 6 times fast):**
```bash
for i in {1..6}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://your-deployed-url/check \
    -H "Content-Type: application/json" \
    -d '{"client_key": "smoke_test"}'
done
# Expected: 200 200 200 200 200 429
```

**Load test against the deployed URL:**
```bash
BASE_URL=https://your-deployed-url k6 run scripts/loadtest.js
```

---

## Redis Persistence Verification

After deploy, confirm that bucket state survives a Redis restart:

```bash
# Make some requests to create a bucket
curl -X POST https://your-deployed-url/check \
  -H "Content-Type: application/json" \
  -d '{"client_key": "persist_test"}'

# Check the token count
curl https://your-deployed-url/admin/clients/persist_test
# Note the "tokens" value

# Restart Redis (Docker Compose)
docker compose restart redis

# Wait a few seconds, then check again
curl https://your-deployed-url/admin/clients/persist_test
# "tokens" should be close to the value before restart (AOF replay restores state)
```

---

## Production Checklist

- [ ] `REDIS_URL` is set to the correct Redis host
- [ ] `.env` is never committed to Git (it's in `.gitignore`)
- [ ] App is behind HTTPS (Nginx + Certbot, or Railway's auto-TLS)
- [ ] Redis port `6379` is NOT exposed publicly — only `127.0.0.1:6379` or internal Docker network
- [ ] `/admin` endpoints are behind a firewall, VPN, or access control (not public by default)
- [ ] `docker compose logs` shows `[redis] connected` on startup
- [ ] `/health` returns `{"status":"ok","redis":"connected"}`
- [ ] Load test passes: `k6 run scripts/loadtest.js`
