import fs from 'fs';
import path from 'path';
import pool, { initDb } from './db.js';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

// Check parent workspace and current folder for search_queries.csv, falling back to mock_dataset.csv
const DATASET_PATH = fs.existsSync(path.resolve('../search_queries.csv'))
  ? path.resolve('../search_queries.csv')
  : fs.existsSync(path.resolve('search_queries.csv'))
    ? path.resolve('search_queries.csv')
    : path.resolve('mock_dataset.csv');

// List of query components to generate realistic-looking search terms (for fallback generation)
const topics = [
  'iphone', 'macbook', 'samsung', 'playstation', 'xbox', 'nintendo', 'ipad', 'netflix', 'amazon',
  'react tutorial', 'javascript arrays', 'nodejs express', 'postgres index', 'redis cluster',
  'how to learn python', 'machine learning', 'artificial intelligence', 'chatgpt openai',
  'best chicken recipe', 'pizza near me', 'flight status', 'weather forecast', 'stock market',
  'gold price today', 'fifa world cup', 'olympics 2026', 'marvel movies', 'star wars series',
  'tesla model y', 'toyota rav4', 'honda civic', 'cryptocurrency bitcoin', 'ethereum news',
  'world news today', 'local gym workout', 'yoga for beginners', 'meditation guide',
  'taylor swift tour', 'billie eilish concert', 'elden ring walkthrough', 'minecraft mods'
];

const modifiers = [
  '15 pro max', 'air m3', 's24 ultra', '5 slim', 'series x', 'switch OLED', 'pro 11 inch',
  'subscription cost', 'prime membership', 'for beginners', 'methods cheatsheet', 'routing middleware',
  'varchar pattern ops', 'consistent hashing', 'in 30 days', 'neural networks', 'deep learning models',
  'prompt engineering tips', 'easy steps', 'gluten free options', 'to new york', 'in london',
  'dow jones index', 'historical highs', 'schedule tables', 'tickets pricing', 'trailer release',
  'timeline review', 'range and features', 'hybrid reviews', 'maintenance costs', 'price prediction',
  'gas fees updates', 'breaking headlines', 'no equipment', 'morning routine', 'anxiety relief',
  'setlist reviews', 'tickets resale', 'boss guide', 'server setup'
];

function generateMockDataset(filePath) {
  logger.info(`Generating fallback 100,000 search queries CSV dataset at ${filePath}...`);
  const writeStream = fs.createWriteStream(filePath);
  writeStream.write('query,count,last_searched_at\n');

  let rowsWritten = 0;

  // Generate unique combinations
  const searchQueriesPool = [];
  topics.forEach((t) => {
    modifiers.forEach((m) => {
      searchQueriesPool.push(`${t} ${m}`);
    });
  });

  const uniqueCount = searchQueriesPool.length;
  for (let i = 0; i < 15000 - uniqueCount; i++) {
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];
    const randomMod = modifiers[Math.floor(Math.random() * modifiers.length)];
    searchQueriesPool.push(`${randomTopic} ${randomMod} ${Math.floor(Math.random() * 100)}`);
  }

  // 1. Write queries with count column
  for (let i = 0; i < 80000; i++) {
    const query = searchQueriesPool[Math.floor(Math.random() * searchQueriesPool.length)];
    const count = Math.floor(Math.random() * 4995) + 5; // 5 to 5000
    writeStream.write(`"${query}",${count},"${new Date().toISOString()}"\n`);
    rowsWritten++;
  }

  // 2. Write queries with missing/empty count
  const missingCountQueries = [
    'how to build an autocomplete trie',
    'redis sorted sets for typeahead',
    'consistent hashing ketama ring',
    'batch writes performance pg',
    'express middleware tutorial',
    'react functional hooks guide',
    'debounce input in react custom hooks',
    'postgreSQL varchar_pattern_ops query optimization',
    'trending search scoring algorithm weights',
    'university software architecture project typeahead'
  ];

  for (let i = 0; i < 20000; i++) {
    const query = missingCountQueries[Math.floor(Math.random() * missingCountQueries.length)];
    writeStream.write(`"${query}",,"${new Date().toISOString()}"\n`);
    rowsWritten++;
  }

  writeStream.end();
  logger.info(`Successfully generated ${rowsWritten} dataset records.`);
}

async function flushLoaderBatch(client, batch) {
  const aggregates = {};
  batch.forEach((b) => {
    if (!aggregates[b.query_text]) {
      aggregates[b.query_text] = { count: 0, last_searched_at: b.last_searched_at };
    }
    aggregates[b.query_text].count += b.count;
    if (new Date(b.last_searched_at) > new Date(aggregates[b.query_text].last_searched_at)) {
      aggregates[b.query_text].last_searched_at = b.last_searched_at;
    }
  });

  const uniqueBatch = Object.keys(aggregates).map((qText) => ({
    query_text: qText,
    count: aggregates[qText].count,
    last_searched_at: aggregates[qText].last_searched_at,
  }));

  if (uniqueBatch.length === 0) return;

  const values = uniqueBatch.map((_, i) =>
    `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}::timestamptz, NOW())`
  ).join(',');
  const params = uniqueBatch.flatMap(b => [b.query_text, b.count, b.last_searched_at]);
  
  await client.query(
    `INSERT INTO queries (query_text, count, last_searched_at, created_at)
     VALUES ${values}
     ON CONFLICT (query_text) DO UPDATE
       SET count = queries.count + EXCLUDED.count,
           last_searched_at = GREATEST(queries.last_searched_at, EXCLUDED.last_searched_at),
           updated_at = NOW()`,
    params
  );
}

async function loadDataset() {
  await initDb();

  if (!fs.existsSync(DATASET_PATH)) {
    generateMockDataset(DATASET_PATH);
  }

  logger.info(`Reading dataset from ${DATASET_PATH} and seeding PostgreSQL...`);
  
  const client = await pool.connect();
  let batch = [];
  let totalImported = 0;
  
  try {
    const fileContent = fs.readFileSync(DATASET_PATH, 'utf-8');
    const lines = fileContent.split('\n');

    if (lines.length === 0) {
      throw new Error('Dataset file is empty.');
    }

    // Parse header to map columns dynamically
    const header = lines[0].trim().toLowerCase();
    const columns = header.split(',');
    
    const queryIdx = columns.indexOf('query');
    const countIdx = columns.indexOf('count');
    const lastSearchedIdx = columns.indexOf('last_searched_at');

    if (queryIdx === -1) {
      throw new Error('CSV headers must contain a "query" column.');
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let parts = [];
      // Simple CSV split handling optional double quotes
      if (line.includes('"')) {
        parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
        parts = parts.map(p => p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
      } else {
        parts = line.split(',');
      }

      if (parts.length <= queryIdx) continue;

      const query = parts[queryIdx]?.trim().toLowerCase();
      if (!query) continue;

      const countValStr = countIdx !== -1 ? parts[countIdx]?.trim() : '';
      const rawCount = parseInt(countValStr, 10);
      
      // If count is missing, aggregate occurrences (frequency derivation)
      const countValue = isNaN(rawCount) ? 1 : rawCount;

      let lastSearchedAt = new Date().toISOString();
      if (lastSearchedIdx !== -1 && parts[lastSearchedIdx]) {
        const rawDate = parts[lastSearchedIdx].trim();
        if (rawDate) {
          const parsedDate = new Date(rawDate);
          if (!isNaN(parsedDate.getTime())) {
            lastSearchedAt = parsedDate.toISOString();
          }
        }
      }

      batch.push({
        query_text: query,
        count: countValue,
        last_searched_at: lastSearchedAt
      });

      if (batch.length >= 2000) {
        await flushLoaderBatch(client, batch);
        totalImported += batch.length;
        logger.info(`Seeded ${totalImported} / ${lines.length - 1} queries...`);
        batch = [];
      }
    }

    if (batch.length > 0) {
      await flushLoaderBatch(client, batch);
      totalImported += batch.length;
    }

    logger.info(`Dataset loaded successfully! Total records processed: ${totalImported}`);

    // Verify loading by checking details of some loaded records
    const checkRes = await client.query(`
      SELECT query_text, count, last_searched_at FROM queries 
      ORDER BY count DESC 
      LIMIT 3
    `);
    
    logger.info('Sample Seeded Database Records (ordered by count descending):');
    checkRes.rows.forEach((row) => {
      logger.info(`  Query: "${row.query_text}" -> Count: ${row.count} -> Last Searched: ${row.last_searched_at}`);
    });

  } catch (err) {
    logger.error(err, 'Failed to parse or seed dataset');
  } finally {
    client.release();
    pool.end();
    logger.info('Database connection closed.');
  }
}

// Execute seeding
loadDataset();
