import pg from 'pg';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Setup schema on startup
export async function initDb() {
  const client = await pool.connect();
  try {
    logger.info('Initializing PostgreSQL database schema...');
    
    // Create queries table
    await client.query(`
      CREATE TABLE IF NOT EXISTS queries (
        id BIGSERIAL PRIMARY KEY,
        query_text VARCHAR(200) NOT NULL UNIQUE,
        count INTEGER NOT NULL DEFAULT 1,
        score NUMERIC(5,2) NOT NULL DEFAULT 0.00,
        last_searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create prefix index using varchar_pattern_ops for efficient ILIKE 'prefix%' queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_queries_query_text_prefix 
      ON queries (query_text varchar_pattern_ops);
    `);

    // Create score sort index for trending list retrieval
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_queries_score_desc 
      ON queries (score DESC);
    `);

    // Create last_searched_at index for recency filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_queries_last_searched_at 
      ON queries (last_searched_at DESC);
    `);

    // Create composite index for the common query pattern: WHERE query_text ILIKE 'prefix%' ORDER BY score DESC
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_queries_text_score
      ON queries (query_text varchar_pattern_ops, score DESC);
    `);

    logger.info('PostgreSQL schema initialized successfully.');
  } catch (err) {
    logger.error('Failed to initialize database schema:', err);
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
