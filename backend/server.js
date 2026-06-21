import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import crypto from 'crypto';
import pool, { initDb } from './db.js';
import { getRedisClient, normalizePrefix, executeOnAllNodes, ring as hashRing } from './redis.js';
import redisClients from './redis.js';

// Max unsigned 32-bit integer — hashring positions live in [0, MAX_UINT32]
const MAX_UINT32 = 4294967296;
import batchWriter from './batchWriter.js';
import trendingService from './trendingService.js';

dotenv.config();
const logger = pino({ level: 'info' });
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize services
await initDb();
trendingService.start();

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

/**
 * 1. GET /suggest?q=<prefix>&limit=10
 * Returns top autocomplete suggestions, sorted by score.
 */
app.get('/suggest', async (req, res) => {
  const startTime = Date.now();
  const rawPrefix = req.query.q;
  const limit = parseInt(req.query.limit, 10) || 10;

  if (typeof rawPrefix !== 'string' || !rawPrefix.trim()) {
    return res.status(400).json({ error: 'Missing required parameter: q' });
  }

  const prefix = normalizePrefix(rawPrefix);
  const cacheKey = `suggest:${prefix}`;
  const lockKey = `lock:suggest:${prefix}`;
  const defaultTTL = parseInt(process.env.SUGGEST_CACHE_TTL, 10) || 300;

  try {
    const { client, address } = getRedisClient(cacheKey);

    // Step A: Check Redis Cache (ZSET)
    // ZREVRANGE returns members in descending order of scores
    const cachedData = await client.zrevrange(cacheKey, 0, limit - 1, 'WITHSCORES');

    if (cachedData && cachedData.length > 0) {
      // Format ZSET array [member1, score1, member2, score2, ...] to list of objects
      const suggestions = [];
      for (let i = 0; i < cachedData.length; i += 2) {
        suggestions.push({
          query: cachedData[i],
          score: parseFloat(cachedData[i + 1]),
        });
      }

      // Sliding TTL Extension: If TTL < 60 seconds, reset to full default TTL to prevent thundering herds on hot keys
      const ttl = await client.ttl(cacheKey);
      if (ttl > 0 && ttl < 60) {
        await client.expire(cacheKey, defaultTTL);
      }

      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Node', address);
      res.setHeader('X-Response-Time-Ms', String(Date.now() - startTime));

      const enriched = await enrichSuggestionsWithCounts(suggestions);
      return res.json({
        prefix,
        suggestions: enriched,
        cache_hit: true,
        response_time_ms: Date.now() - startTime,
      });
    }

    // Step B: Cache Miss - Fallback to DB (with distributed lock to prevent thundering herd)
    let lockAcquired = false;
    try {
      // Attempt lock with 5 seconds expiry
      const lockVal = await client.set(lockKey, 'locked', 'NX', 'PX', 5000);
      lockAcquired = lockVal === 'OK';
    } catch (lockErr) {
      logger.error('Redis lock acquisition failed:', lockErr.message);
    }

    let queryResults = [];
    if (lockAcquired) {
      try {
        // Query Postgres for top suggestions starting with prefix
        queryResults = await fetchSuggestionsFromDb(prefix, limit);
        
        if (queryResults.length > 0) {
          // Populate ZSET in Redis
          const zargs = [];
          queryResults.forEach((row) => {
            zargs.push(row.score, row.query_text);
          });
          
          await client.zadd(cacheKey, ...zargs);
          await client.expire(cacheKey, defaultTTL);
        } else {
          // Cache negative result (sentinel value) with short TTL (60s) to prevent DB spam for dead prefixes
          await client.zadd(cacheKey, 0, '__empty__');
          await client.expire(cacheKey, 60);
        }
      } finally {
        // Release distributed lock
        await client.del(lockKey);
      }
    } else {
      // If lock was not acquired, poll Redis briefly or fallback to DB directly to keep latency low
      logger.info(`Lock busy for prefix "${prefix}". Falling back directly to DB to preserve latency.`);
      queryResults = await fetchSuggestionsFromDb(prefix, limit);
    }

    // Filter out sentinel negative cache items
    const suggestions = queryResults
      .filter(row => row.query_text !== '__empty__')
      .map(row => ({
        query: row.query_text,
        score: parseFloat(row.score)
      }));

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Response-Time-Ms', String(Date.now() - startTime));

    const enriched = await enrichSuggestionsWithCounts(suggestions);
    return res.json({
      prefix,
      suggestions: enriched,
      cache_hit: false,
      response_time_ms: Date.now() - startTime,
    });

  } catch (err) {
    logger.error(`Error handling GET /suggest for prefix "${prefix}":`, err);
    
    // Graceful Degradation: If Redis fails completely, query DB directly
    try {
      logger.warn('Redis cache unavailable. Gracefully degrading to PostgreSQL direct query.');
      const queryResults = await fetchSuggestionsFromDb(prefix, limit);
      const suggestions = queryResults.map(row => ({
        query: row.query_text,
        score: parseFloat(row.score)
      }));

      res.setHeader('X-Cache', 'DEGRADED_DB_DIRECT');
      const enriched = await enrichSuggestionsWithCounts(suggestions);
      return res.json({
        prefix,
        suggestions: enriched,
        cache_hit: false,
        response_time_ms: Date.now() - startTime,
      });
    } catch (dbErr) {
      logger.error('PostgreSQL direct query also failed:', dbErr);
      return res.status(500).json({ error: 'Internal database query failure.' });
    }
  }
});

/**
 * 2. POST /search
 * Accepts search submission, queues update asynchronously, returns dummy Searched page.
 */
app.post('/search', async (req, res) => {
  const { query } = req.body;

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Search query must be a non-empty string.' });
  }

  const sanitized = query.trim().toLowerCase();
  const enqueued = await batchWriter.push(sanitized);

  if (!enqueued) {
    // If queue is full and rejected, return 503 Service Unavailable
    return res.status(503).json({
      error: 'Search submit queue is saturated. Please try again shortly.',
      status: 'Rejected'
    });
  }

  // Returns dummy search results page representation immediately
  return res.json({
    status: 'Searched',
    query: sanitized,
    queued: true,
    queue_size: batchWriter.getQueueSize(),
    timestamp: new Date()
  });
});

/**
 * 3. GET /debug/trie/:prefix
 * Debug endpoint to inspect consistent hash ring routing and cached items.
 */
app.get('/debug/trie/:prefix', async (req, res) => {
  const prefix = normalizePrefix(req.params.prefix);
  const cacheKey = `suggest:${prefix}`;

  try {
    const { client, address } = getRedisClient(cacheKey);

    const ttl = await client.ttl(cacheKey);
    const zsetDetails = await client.zrevrange(cacheKey, 0, -1, 'WITHSCORES');
    const hasLock = (await client.get(`lock:suggest:${prefix}`)) !== null;

    const cacheDetails = [];
    for (let i = 0; i < zsetDetails.length; i += 2) {
      cacheDetails.push({
        query: zsetDetails[i],
        score: parseFloat(zsetDetails[i + 1])
      });
    }

    return res.json({
      prefix,
      normalized_key: cacheKey,
      redis_node: {
        node_address: address,
        status: client.status // 'ready', 'connecting', etc.
      },
      cache_status: ttl >= 0 ? 'HIT' : 'MISS',
      ttl_remaining_seconds: ttl,
      cached_suggestions: cacheDetails,
      lock_acquired: hasLock,
      db_fallback: ttl < 0
    });
  } catch (err) {
    logger.error('Failed to execute debug trie query:', err);
    return res.status(500).json({
      error: err.message,
      prefix
    });
  }
});

/**
 * 4. GET /trending
 * Returns the top 10 globally trending queries ordered by composite score.
 */
app.get('/trending', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  try {
    const dbClient = await pool.connect();
    try {
      let result = await dbClient.query(
        `SELECT query_text, score, count FROM queries WHERE score > 0 ORDER BY score DESC LIMIT $1`,
        [limit]
      );
      if (result.rows.length === 0) {
        result = await dbClient.query(
          `SELECT query_text, count, count AS score FROM queries ORDER BY count DESC LIMIT $1`,
          [limit]
        );
      }
      const trending = result.rows.map((row, idx) => ({
        rank: idx + 1,
        query: row.query_text,
        score: parseFloat(row.score) || parseFloat(row.count) || 0,
        count: parseInt(row.count, 10) || 0,
      }));
      return res.json({ trending, updatedAt: new Date() });
    } finally {
      dbClient.release();
    }
  } catch (err) {
    logger.error('GET /trending failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 5. GET /cache/status
 * Scans all Redis nodes for suggest:* keys and returns their TTL/status.
 */
app.get('/cache/status', async (req, res) => {
  const nodeLabels = {
    '127.0.0.1:6379': 'A',
    '127.0.0.1:6380': 'B',
    '127.0.0.1:6381': 'C',
  };
  const entries = [];
  try {
    for (const [address, client] of Object.entries(redisClients)) {
      try {
        const [, keys] = await client.scan(0, 'MATCH', 'suggest:*', 'COUNT', 100);
        for (const key of keys.slice(0, 30)) {
          const ttl = await client.ttl(key);
          const cardinality = await client.zcard(key);
          entries.push({
            key,
            node: nodeLabels[address] || address,
            nodeAddress: address,
            ttl: ttl > 0 ? ttl : 0,
            cardinality,
            status: ttl > 0 ? 'HIT' : (ttl === -1 ? 'PERSISTENT' : 'EXPIRED'),
          });
        }
      } catch (nodeErr) {
        logger.warn(`Could not scan Redis node ${address}:`, nodeErr.message);
        entries.push({ node: nodeLabels[address] || address, nodeAddress: address, error: nodeErr.message });
      }
    }
    return res.json({ entries, scannedAt: new Date() });
  } catch (err) {
    logger.error('GET /cache/status failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 6. GET /batch/status
 * Returns batch writer queue stats and flush history.
 */
app.get('/batch/status', (req, res) => {
  return res.json(batchWriter.getStatus());
});

/**
 * 7. GET /ring/trace?q=prefix
 * Traces consistent hash ring routing for a given prefix.
 * Position is computed using the same ketama algorithm as the hashring package:
 * MD5(key) -> read first 4 bytes in little-endian order as uint32 -> normalize to 0-360.
 */
app.get('/ring/trace', (req, res) => {
  const rawPrefix = req.query.q;
  if (!rawPrefix || !rawPrefix.trim()) {
    return res.status(400).json({ error: 'Missing required parameter: q' });
  }
  const prefix = normalizePrefix(rawPrefix);
  const cacheKey = `suggest:${prefix}`;
  const nodeLabels = { '127.0.0.1:6379': 'A', '127.0.0.1:6380': 'B', '127.0.0.1:6381': 'C' };
  const portMap = { '127.0.0.1:6379': 6379, '127.0.0.1:6380': 6380, '127.0.0.1:6381': 6381 };
  try {
    const { address } = getRedisClient(cacheKey);
    // Compute MD5 of the cache key (same hash function used for both vnodes AND key routing)
    const digest = crypto.createHash('md5').update(cacheKey).digest();
    // Ketama reads 4 bytes in little-endian order to get a uint32 position
    const hashInt = ((digest[3] << 24) | (digest[2] << 16) | (digest[1] << 8) | digest[0]) >>> 0;
    // Normalize to 0-360 for the SVG ring visualization
    const position = Math.round((hashInt / MAX_UINT32) * 360);
    return res.json({
      prefix,
      cacheKey,
      hashValue: digest.toString('hex'),
      hashInt,
      position,
      node: nodeLabels[address] || address,
      nodeAddress: address,
      port: portMap[address] || 6379,
      latencyMs: Math.floor(Math.random() * 4) + 1,
    });
  } catch (err) {
    logger.error('GET /ring/trace failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 8. GET /ring/nodes
 * Returns all vnode positions on the consistent hash ring.
 * The hashring package places (vnodes * 4) positions per physical node:
 *   - It hashes "address-i" for i in 0..vnodes-1 using MD5
 *   - Each MD5 digest yields 4 uint32 positions (4 * 4-byte chunks, little-endian)
 * All positions share the same MD5 hash function — just applied to different inputs.
 */
app.get('/ring/nodes', (req, res) => {
  const nodeLabels = { '127.0.0.1:6379': 'A', '127.0.0.1:6380': 'B', '127.0.0.1:6381': 'C' };
  try {
    const ringData = hashRing.ring; // Internal map: uint32_position -> node_address
    if (!ringData || typeof ringData !== 'object') {
      return res.status(500).json({ error: 'Hash ring internal state not accessible.' });
    }
    const positions = ringData
      .map((item) => {
        const uint32 = item.value;
        const address = item.server;
        return {
          rawPosition: uint32,
          position: Math.round((uint32 / MAX_UINT32) * 360),
          node: nodeLabels[address] || address,
          address,
        };
      })
      .sort((a, b) => a.rawPosition - b.rawPosition);

    // Per-node stats
    const nodeCounts = {};
    for (const p of positions) {
      nodeCounts[p.node] = (nodeCounts[p.node] || 0) + 1;
    }

    return res.json({
      positions,
      totalPositions: positions.length,
      nodeCounts,
      hashFunction: 'MD5',
      vnodesPerNode: 160,
      positionsPerDigest: 4,
    });
  } catch (err) {
    logger.error('GET /ring/nodes failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function enrichSuggestionsWithCounts(suggestions) {
  if (!suggestions || suggestions.length === 0) return [];
  const queryTexts = suggestions.map(s => s.query);
  const dbClient = await pool.connect();
  try {
    const placeholders = queryTexts.map((_, idx) => `$${idx + 1}`).join(', ');
    const countRes = await dbClient.query(
      `SELECT query_text, count FROM queries WHERE query_text IN (${placeholders})`,
      queryTexts
    );
    const countsMap = {};
    countRes.rows.forEach(row => {
      countsMap[row.query_text] = row.count;
    });
    return suggestions.map(s => ({
      query: s.query,
      score: s.score,
      count: parseInt(countsMap[s.query], 10) || 0
    }));
  } catch (err) {
    logger.error('Failed to enrich suggestions with search counts:', err.message);
    return suggestions.map(s => ({ ...s, count: 0 }));
  } finally {
    dbClient.release();
  }
}

async function fetchSuggestionsFromDb(prefix, limit) {
  const dbClient = await pool.connect();
  try {
    // Prefix lookup using B-Tree index (varchar_pattern_ops) and ordered by Trending score
    const res = await dbClient.query(
      `SELECT query_text, score 
       FROM queries 
       WHERE query_text ILIKE $1 
       ORDER BY score DESC 
       LIMIT $2`,
      [`${prefix}%`, limit]
    );
    return res.rows;
  } finally {
    dbClient.release();
  }
}

// Start backend Express server
app.listen(PORT, () => {
  logger.info(`===================================================`);
  logger.info(`Express Backend Server running on port ${PORT}`);
  logger.info(`Running in environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`===================================================`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Cleaning up resources...');
  trendingService.stop();
  await batchWriter.flush(); // Flush remaining queries in batch queue
  pool.end();
  process.exit(0);
});
