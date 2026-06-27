const express = require('express');
const redis = require('../redis');
const { checkTokenBucket } = require('../algorithms/tokenBucket');
const { checkSlidingWindow } = require('../algorithms/slidingWindow');

const router = express.Router();

const DEFAULT_RPS = parseFloat(process.env.DEFAULT_RPS || '10');
const DEFAULT_BURST = parseInt(process.env.DEFAULT_BURST || '20', 10);

router.post('/', async (req, res, next) => {
  try {
    const { client_key } = req.body;

    if (!client_key || typeof client_key !== 'string') {
      return res.status(400).json({ error: 'client_key is required' });
    }

    const config = await redis.hgetall(`config:${client_key}`);
    const rps = config && config.rps ? parseFloat(config.rps) : DEFAULT_RPS;
    const burst = config && config.burst ? parseInt(config.burst, 10) : DEFAULT_BURST;
    const algorithm = (config && config.algorithm) || 'token_bucket';

    let result;
    if (algorithm === 'sliding_window') {
      result = await checkSlidingWindow(client_key, rps, burst);
    } else {
      result = await checkTokenBucket(client_key, rps, burst);
    }

    res.set('X-RateLimit-Limit', burst);
    res.set('X-RateLimit-Remaining', result.remaining);
    res.set('X-RateLimit-Reset', result.reset);

    const status = result.decision === 'ALLOW' ? 200 : 429;
    res.status(status).json({
      decision: result.decision,
      remaining: result.remaining,
      reset: result.reset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
