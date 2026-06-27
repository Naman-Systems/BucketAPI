const redis = require('../redis');

// Weighted sliding window: blends the previous fixed window into the current
// one to avoid the burst problem at window boundaries.
// weighted = prev_count * (1 - elapsed_fraction) + curr_count
const LUA = `
local base_key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

local curr_window = math.floor(now / window_ms)
local prev_window = curr_window - 1

local curr_key = base_key .. ':' .. curr_window
local prev_key = base_key .. ':' .. prev_window

local curr_count = tonumber(redis.call('GET', curr_key)) or 0
local prev_count = tonumber(redis.call('GET', prev_key)) or 0

local elapsed_fraction = (now % window_ms) / window_ms
local weighted = prev_count * (1 - elapsed_fraction) + curr_count

local decision, remaining, reset

if weighted < limit then
  redis.call('INCR', curr_key)
  redis.call('PEXPIRE', curr_key, window_ms * 2)
  decision = 'ALLOW'
  remaining = math.max(0, math.floor(limit - weighted - 1))
  reset = math.ceil((curr_window + 1) * window_ms / 1000)
else
  decision = 'DENY'
  remaining = 0
  reset = math.ceil((curr_window + 1) * window_ms / 1000)
end

return { decision, tostring(remaining), tostring(reset) }
`;

async function checkSlidingWindow(clientKey, rps, burst) {
  const key = `sw:${clientKey}`;
  const now = Date.now();
  const windowMs = 1000;
  const result = await redis.eval(LUA, 1, key, now, windowMs, burst);
  return {
    decision: result[0],
    remaining: parseInt(result[1], 10),
    reset: parseInt(result[2], 10),
  };
}

module.exports = { checkSlidingWindow };
