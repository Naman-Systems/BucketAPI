const redis = require('../redis');

// Atomic token bucket: read tokens + last_refill, refill based on elapsed time,
// deduct 1 if available, write back — all in one Redis EVAL so no race conditions.
const LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if not tokens then
  tokens = burst
  last_refill = now
end

local elapsed = math.max(0, (now - last_refill) / 1000)
local refilled = elapsed * rate
tokens = math.min(burst, tokens + refilled)

local decision, remaining, reset

if tokens >= 1 then
  tokens = tokens - 1
  decision = 'ALLOW'
  remaining = math.floor(tokens)
  reset = math.ceil(now / 1000 + (1 / rate))
else
  decision = 'DENY'
  remaining = 0
  reset = math.ceil(now / 1000 + (1 - tokens) / rate)
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(now))

return { decision, tostring(remaining), tostring(reset) }
`;

async function checkTokenBucket(clientKey, rps, burst) {
  const key = `bucket:${clientKey}`;
  const now = Date.now();
  const result = await redis.eval(LUA, 1, key, now, rps, burst);
  return {
    decision: result[0],
    remaining: parseInt(result[1], 10),
    reset: parseInt(result[2], 10),
  };
}

module.exports = { checkTokenBucket };
