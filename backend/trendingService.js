import pool from './db.js';
import { getRedisClient, normalizePrefix } from './redis.js';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

const INTERVAL_MS = parseInt(process.env.TRENDING_CRON_INTERVAL_MS, 10) || 300000;
const RECENCY_WEIGHT = parseFloat(process.env.TRENDING_RECENCY_WEIGHT) || 0.3;
const TOTAL_WEIGHT = parseFloat(process.env.TRENDING_TOTAL_WEIGHT) || 0.7;
const RECENCY_WINDOW_MINUTES = parseInt(process.env.TRENDING_RECENCY_WINDOW_MINUTES, 10) || 60;

class TrendingService {
  constructor() {
    this.timer = null;
    this.isRunning = false;
  }

  start() {
    logger.info(`Starting Trending Search Service (Interval: ${INTERVAL_MS / 1000}s, Recency Window: ${RECENCY_WINDOW_MINUTES}m)`);
    // Run initial execution after 5 seconds to warm up
    setTimeout(() => this.run(), 5000);
    this.timer = setInterval(() => this.run(), INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Trending Search Service run initiated...');

    try {
      // 1. Determine recent hourly ZSET keys to check
      const now = new Date();
      const hourlyKeys = [];
      for (let i = 0; i < Math.ceil(RECENCY_WINDOW_MINUTES / 60) + 1; i++) {
        const d = new Date(now.getTime() - i * 3600 * 1000);
        const YYYY = d.getFullYear();
        const MM = String(d.getMonth() + 1).padStart(2, '0');
        const DD = String(d.getDate()).padStart(2, '0');
        const HH = String(d.getHours()).padStart(2, '0');
        hourlyKeys.push(`recent_searches:${YYYY}${MM}${DD}${HH}`);
      }

      // 2. Fetch recency counts from Redis nodes
      const recencyCounts = {};
      for (const key of hourlyKeys) {
        try {
          const { client } = getRedisClient(key);
          const members = await client.zrevrange(key, 0, -1, 'WITHSCORES');
          for (let idx = 0; idx < members.length; idx += 2) {
            const query = members[idx];
            const score = parseFloat(members[idx + 1]);
            recencyCounts[query] = (recencyCounts[query] || 0) + score;
          }
        } catch (err) {
          logger.error(`Failed to fetch ZSET ${key} from Redis:`, err.message);
        }
      }

      const activeRecentQueries = Object.keys(recencyCounts);
      logger.info(`Found ${activeRecentQueries.length} queries with recent activity in Redis.`);

      // 3. Fetch top queries from database to blend with recent queries
      const client = await pool.connect();
      let topQueries = [];
      try {
        const res = await client.query('SELECT query_text, count FROM queries ORDER BY count DESC LIMIT 500');
        topQueries = res.rows;
      } finally {
        client.release();
      }

      // Union of active recent queries and top historical queries
      const queryMap = new Map(); // Map of query_text -> { totalCount, recencyCount }
      
      topQueries.forEach((q) => {
        queryMap.set(q.query_text, { totalCount: q.count, recencyCount: 0 });
      });

      // Fetch actual database counts for queries with recent activity that aren't in the top 500
      const missingDbQueries = activeRecentQueries.filter(q => !queryMap.has(q));
      if (missingDbQueries.length > 0) {
        const client2 = await pool.connect();
        try {
          // Batch fetch in chunks of 200
          for (let i = 0; i < missingDbQueries.length; i += 200) {
            const chunk = missingDbQueries.slice(i, i + 200);
            const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(', ');
            const res = await client2.query(
              `SELECT query_text, count FROM queries WHERE query_text IN (${placeholders})`,
              chunk
            );
            res.rows.forEach((r) => {
              queryMap.set(r.query_text, { totalCount: r.count, recencyCount: 0 });
            });
          }
        } finally {
          client2.release();
        }
      }

      // Merge recency counts
      for (const [qText, recVal] of Object.entries(recencyCounts)) {
        if (queryMap.has(qText)) {
          queryMap.get(qText).recencyCount = recVal;
        } else {
          // If query has recent activity but count not found in DB (shouldn't happen because of batch writes), init count
          queryMap.set(qText, { totalCount: recVal, recencyCount: recVal });
        }
      }

      if (queryMap.size === 0) {
        logger.info('No queries found to calculate trending scores.');
        this.isRunning = false;
        return;
      }

      // 4. Calculate scores and find max counts for normalization
      let maxTotalCount = 1;
      let maxRecencyCount = 1;

      for (const [_, vals] of queryMap.entries()) {
        if (vals.totalCount > maxTotalCount) maxTotalCount = vals.totalCount;
        if (vals.recencyCount > maxRecencyCount) maxRecencyCount = vals.recencyCount;
      }

      const calculatedScores = []; // Array of { query, score }
      
      for (const [qText, vals] of queryMap.entries()) {
        // total count compression using log2
        const normTotal = Math.log2(vals.totalCount + 1) / Math.log2(maxTotalCount + 1);
        const normRecency = vals.recencyCount / maxRecencyCount;
        
        const finalScore = (TOTAL_WEIGHT * normTotal) + (RECENCY_WEIGHT * normRecency);
        // Scale to 0-100 for readability
        const scaledScore = Math.min(100, Math.max(0, parseFloat((finalScore * 100).toFixed(2))));
        
        calculatedScores.push({ query: qText, score: scaledScore });
      }

      // Sort by score descending
      calculatedScores.sort((a, b) => b.score - a.score);

      // 5. Update Postgres scores in a single batch statement
      const dbClient = await pool.connect();
      try {
        logger.info(`Updating scores for ${calculatedScores.length} queries in database...`);
        // Batch update up to 1000 items in chunks of 200
        for (let i = 0; i < calculatedScores.length; i += 200) {
          const chunk = calculatedScores.slice(i, i + 200);
          const valuesClause = chunk.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2}::numeric(5,2))`).join(', ');
          const params = chunk.flatMap(c => [c.query, c.score]);
          
          await dbClient.query(`
            UPDATE queries AS q
            SET score = val.score,
                updated_at = NOW()
            FROM (VALUES ${valuesClause}) AS val(query_text, score)
            WHERE q.query_text = val.query_text
          `, params);
        }
      } catch (err) {
        logger.error('Failed to update scores in PostgreSQL:', err.message);
      } finally {
        dbClient.release();
      }

      // 6. Update Redis prefix ZSET suggestions (top 300 trending queries to keep cache fast)
      logger.info('Re-indexing prefix suggestion keys in Redis...');
      const cacheTargetQueries = calculatedScores.slice(0, 300);

      // Aggregate prefix updates to execute via pipeline/multi on respective Redis nodes
      // Structure: nodeAddress -> array of operations
      const prefixOperations = {};

      for (const item of cacheTargetQueries) {
        const query = item.query;
        const score = item.score;
        
        // Generate prefixes from length 1 to 10
        const maxLength = Math.min(10, query.length);
        for (let len = 1; len <= maxLength; len++) {
          const rawPrefix = query.substring(0, len);
          const normalized = normalizePrefix(rawPrefix);
          if (!normalized) continue;
          
          const prefixKey = `suggest:${normalized}`;
          const { address } = getRedisClient(prefixKey);
          
          if (!prefixOperations[address]) {
            prefixOperations[address] = [];
          }
          prefixOperations[address].push({ prefixKey, score, query });
        }
      }

      // Execute updates using Redis MULTI pipeline per node
      for (const [address, ops] of Object.entries(prefixOperations)) {
        try {
          const { client } = getRedisClient(ops[0].prefixKey); // retrieve client for this node address
          const pipeline = client.pipeline();
          
          // Group operations by key to set TTL and trim sizes
          const keysTouched = new Set();
          
          ops.forEach((op) => {
            pipeline.zadd(op.prefixKey, op.score, op.query);
            keysTouched.add(op.prefixKey);
          });

          // Trim to top 50, and set TTL for each touched key
          keysTouched.forEach((key) => {
            pipeline.zremrangebyrank(key, 0, -51);
            pipeline.expire(key, 600); // 10 minutes cache TTL
          });

          await pipeline.exec();
        } catch (err) {
          logger.error(`Failed to pipe prefix updates to Redis node ${address}:`, err.message);
        }
      }

      logger.info('Trending Search Service run complete.');
    } catch (err) {
      logger.error('Error during Trending Search Service execution:', err);
    } finally {
      this.isRunning = false;
    }
  }
}

const trendingService = new TrendingService();
export default trendingService;
