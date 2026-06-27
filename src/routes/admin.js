const express = require('express');
const redis = require('../redis');

const router = express.Router();

const VALID_ALGORITHMS = ['token_bucket', 'sliding_window'];

router.post('/clients', async (req, res, next) => {
  try {
    const { client_key, algorithm, requests_per_second, burst_size } = req.body;

    if (!client_key || typeof client_key !== 'string') {
      return res.status(400).json({ error: 'client_key is required' });
    }

    if (algorithm && !VALID_ALGORITHMS.includes(algorithm)) {
      return res.status(400).json({ error: `algorithm must be one of: ${VALID_ALGORITHMS.join(', ')}` });
    }

    if (requests_per_second != null) {
      const rps = Number(requests_per_second);
      if (!isFinite(rps) || rps <= 0) {
        return res.status(400).json({ error: 'requests_per_second must be a positive finite number' });
      }
    }

    if (burst_size != null) {
      const burst = Number(burst_size);
      if (!Number.isInteger(burst) || burst < 1) {
        return res.status(400).json({ error: 'burst_size must be a positive integer' });
      }
    }

    const updates = {};
    if (algorithm) updates.algorithm = algorithm;
    if (requests_per_second != null) updates.rps = String(requests_per_second);
    if (burst_size != null) updates.burst = String(burst_size);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'at least one of algorithm, requests_per_second, burst_size is required' });
    }

    await redis.hmset(`config:${client_key}`, updates);
    res.json({ ok: true, client_key, config: updates });
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const config = await redis.hgetall(`config:${key}`);
    const bucket = await redis.hgetall(`bucket:${key}`);

    res.json({
      client_key: key,
      config: config || {},
      live: {
        tokens: bucket && bucket.tokens ? parseFloat(bucket.tokens) : null,
        last_refill: bucket && bucket.last_refill ? parseInt(bucket.last_refill, 10) : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
