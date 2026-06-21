import pool from './db.js';
import { getRedisClient, normalizePrefix } from './redis.js';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

const FLUSH_INTERVAL_MS = parseInt(process.env.BATCH_FLUSH_INTERVAL_MS, 10) || 10000;
const MAX_BATCH_SIZE = parseInt(process.env.BATCH_MAX_SIZE, 10) || 1000;
const QUEUE_LIMIT = parseInt(process.env.BATCH_QUEUE_LIMIT, 10) || 10000;

class BatchWriter {
  constructor() {
    this.queue = [];
    this.timer = null;
    this.isFlushing = false;
    this.flushHistory = [];
    this.totalFlushed = 0;
    this.totalWrites = 0;
    this.startTimer();
  }

  startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /**
   * Enqueues a search query for DB count updates and increments hourly recency in Redis immediately.
   */
  async push(query) {
    if (typeof query !== 'string' || !query.trim()) return false;
    const normalized = query.trim().toLowerCase();

    // Check queue limit for backpressure
    if (this.queue.length >= QUEUE_LIMIT) {
      logger.warn(`Batch queue is full (${this.queue.length} items). Rejecting query: "${normalized}"`);
      return false;
    }

    // 1. Enqueue for database persistence (batch write)
    this.queue.push({ query: normalized, timestamp: new Date() });

    // 2. Track recency in Redis immediately (used by Trending Service)
    try {
      const now = new Date();
      const YYYY = now.getFullYear();
      const MM = String(now.getMonth() + 1).padStart(2, '0');
      const DD = String(now.getDate()).padStart(2, '0');
      const HH = String(now.getHours()).padStart(2, '0');
      const hourlyBucketKey = `recent_searches:${YYYY}${MM}${DD}${HH}`;

      // Route this hourly bucket key to the correct Redis node
      const { client, address } = getRedisClient(hourlyBucketKey);
      await client.zincrby(hourlyBucketKey, 1, normalized);
      // Auto-expire hourly bucket key after 24 hours to clean up memory
      await client.expire(hourlyBucketKey, 86400); 
    } catch (err) {
      logger.error(`Failed to track recency in Redis for "${normalized}":`, err.message);
    }

    // Flush immediately if we hit max batch size
    if (this.queue.length >= MAX_BATCH_SIZE) {
      logger.info(`Queue size limit reached (${this.queue.length} items). Flushing immediately...`);
      this.flush();
    }

    return true;
  }

  async flush() {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;
    const flushStart = Date.now();

    // Splice all currently queued items
    const batch = this.queue.splice(0, Math.min(this.queue.length, MAX_BATCH_SIZE));
    logger.info(`Flushing batch of ${batch.length} queries to PostgreSQL...`);

    // Aggregate counts in memory for this batch to reduce SQL parameter sizes
    const aggregates = {};
    batch.forEach((item) => {
      aggregates[item.query] = (aggregates[item.query] || 0) + 1;
    });

    const uniqueQueries = Object.keys(aggregates);
    if (uniqueQueries.length === 0) {
      this.isFlushing = false;
      return;
    }

    let success = false;
    let retries = 3;
    let delay = 1000; // start with 1s retry delay

    while (!success && retries > 0) {
      try {
        await this.executeBatchUpsert(uniqueQueries, aggregates);
        success = true;
        logger.info(`Successfully flushed ${batch.length} queries (${uniqueQueries.length} unique) to DB.`);

        // Invalidate Redis prefix suggestion keys for queries that were just flushed
        try {
          for (const query of uniqueQueries) {
            const maxLength = Math.min(10, query.length);
            for (let len = 1; len <= maxLength; len++) {
              const rawPrefix = query.substring(0, len);
              const normalized = normalizePrefix(rawPrefix);
              if (!normalized) continue;

              const prefixKey = `suggest:${normalized}`;
              try {
                const { client } = getRedisClient(prefixKey);
                await client.del(prefixKey);
              } catch (redisErr) {
                logger.error(`Failed to delete Redis key ${prefixKey}:`, redisErr.message);
              }
            }
          }
        } catch (invalidationErr) {
          logger.error('Failed to invalidate Redis cache keys after DB flush:', invalidationErr.message);
        }
      } catch (err) {
        retries--;
        logger.error(`Database flush failed (retries remaining: ${retries}):`, err.message);
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
        }
      }
    }

    if (!success) {
      logger.error(`CRITICAL: Failed to flush batch after multiple retries. Re-enqueuing items to prevent loss.`);
      this.queue.unshift(...batch);
    } else {
      this.totalFlushed++;
      this.totalWrites += batch.length;
    }

    // Record flush history (keep last 20)
    const entry = {
      timestamp: new Date().toISOString(),
      batchSize: batch.length,
      uniqueQueries: uniqueQueries.length,
      durationMs: Date.now() - flushStart,
      status: success ? 'success' : 'failed',
      retriesUsed: 3 - retries,
    };
    this.flushHistory.unshift(entry);
    if (this.flushHistory.length > 20) this.flushHistory.pop();

    this.isFlushing = false;
  }

  /**
   * Helper to perform multi-row parameter insertion in Postgres
   */
  async executeBatchUpsert(queries, aggregates) {
    const valuesClause = [];
    const params = [];
    
    queries.forEach((q, index) => {
      const pIdx1 = index * 2 + 1;
      const pIdx2 = index * 2 + 2;
      valuesClause.push(`($${pIdx1}, $${pIdx2}, NOW(), NOW())`);
      params.push(q, aggregates[q]);
    });

    const queryText = `
      INSERT INTO queries (query_text, count, last_searched_at, updated_at)
      VALUES ${valuesClause.join(', ')}
      ON CONFLICT (query_text) DO UPDATE SET
        count = queries.count + EXCLUDED.count,
        last_searched_at = EXCLUDED.last_searched_at,
        updated_at = NOW();
    `;

    const client = await pool.connect();
    try {
      await client.query(queryText, params);
    } finally {
      client.release();
    }
  }

  getQueueSize() {
    return this.queue.length;
  }

  getFlushHistory() {
    return this.flushHistory;
  }

  getStatus() {
    return {
      queueSize: this.queue.length,
      isFlushing: this.isFlushing,
      totalFlushed: this.totalFlushed,
      totalWrites: this.totalWrites,
      flushIntervalMs: FLUSH_INTERVAL_MS,
      maxBatchSize: MAX_BATCH_SIZE,
      queueLimit: QUEUE_LIMIT,
      flushHistory: this.flushHistory,
    };
  }
}

// Singleton instances
const batchWriter = new BatchWriter();
export default batchWriter;
