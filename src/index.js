require('dotenv').config();
const express = require('express');
const redis = require('./redis');

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', redis: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', redis: 'disconnected' });
  }
});

app.use('/check', require('./routes/check'));
app.use('/admin', require('./routes/admin'));

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[app] BucketAPI running on port ${PORT}`));

module.exports = app;
