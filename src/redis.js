require('dotenv').config();
const Redis = require('ioredis');

const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

client.on('error', (err) => console.error('[redis] error:', err.message));
client.on('connect', () => console.log('[redis] connected'));
client.on('reconnecting', () => console.log('[redis] reconnecting'));

module.exports = client;
