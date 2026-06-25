https://claude.ai/share/1ce2ac7c-5cd0-4c10-8637-9ec26ff5cef1 

🪣 Token Bucket Rate Limiter Service
Small Name: RateGuard (or BucketAPI / ThrottleX / LimitCore)

📌 What It Is



"A standalone API that rate-limits other APIs as a feature — a product"

A networked rate limiting service that other backend services call into, implementing the Token Bucket algorithm with per-client configurable limits, persistent state across restarts, sliding-window mode, and 500+ concurrent requests per second load tested.

🚫 Why This Isn't a Generic Project

"Every backend eventually needs rate limiting, but almost nobody builds it as its own networked service that other services call into. This forces you to think about shared state, clock precision, and concurrency instead of just importing a library."


✅ Core Requirements
#Requirement01Expose an endpoint that, given a client key, returns ALLOW or DENY based on a token bucket algorithm02Support per-client configurable limits (requests per second, burst sizes) set via an admin endpoint03State must survive a service restart — persist bucket state, don't keep it only in memory04Handle concurrent requests for the SAME client key without letting tokens be double-spent (race condition safe)05Provide a sliding-window mode in addition to token bucket, selectable per client06Return standard rate-limit headers (limit, remaining, reset time) on every response07Include a load test proving correctness under 500+ concurrent requests per second

🎯 Stretch Goals

Add a distributed mode where multiple instances of your limiter share state correctly
Build a tiny dashboard showing live request/deny rates per client


🧠 Skills You'll Master

Concurrency control
Atomic operations
Algorithm design
API contracts
Load testing


🛠️ Suggested Tech Stack (your style)
ComponentToolBackendFastAPI or Node.js (Express)State StorageRedis (atomic INCR + TTL — perfect for rate limiting)Concurrency SafetyRedis Lua scripts or atomic transactionsAlgorithmToken Bucket + Sliding Window (both)Load Testingk6 or Apache Bench (ab)Admin APIREST endpoints for per-client configDeployRailway.app / Docker
