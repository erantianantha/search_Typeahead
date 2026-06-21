import Redis from 'ioredis';
import HashRing from 'hashring';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

const nodeAddresses = process.env.REDIS_NODES
  ? process.env.REDIS_NODES.split(',')
  : ['127.0.0.1:6379', '127.0.0.1:6380', '127.0.0.1:6381'];

logger.info(`Initializing Consistent Hashing Ring with nodes: ${nodeAddresses.join(', ')}`);

// Setup consistent hash ring using MD5 (default) and 160 vnodes per physical node
const ring = new HashRing(nodeAddresses, 'md5', {
  'max weight': 2000,
  'vnodes': 160,
});

// Dictionary of active Redis connections
const redisClients = {};

nodeAddresses.forEach((address) => {
  const [host, portStr] = address.split(':');
  const port = parseInt(portStr, 10) || 6379;
  
  logger.info(`Connecting to Redis cache node: ${host}:${port}`);
  
  const client = new Redis({
    host,
    port,
    lazyConnect: true, // Don't block startup if a Redis node is temporarily down
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      // Retry connection after a delay, max delay 2s
      return Math.min(times * 100, 2000);
    }
  });

  client.on('error', (err) => {
    logger.error(`Redis node ${address} connection error:`, err.message);
  });

  client.on('connect', () => {
    logger.info(`Successfully connected to Redis node ${address}`);
  });

  redisClients[address] = client;
  // Connect asynchronously
  client.connect().catch((err) => {
    logger.error(`Initial connection failed for Redis node ${address}:`, err.message);
  });
});

/**
 * Normalizes query string for prefix caching keys
 */
export function normalizePrefix(prefix) {
  if (typeof prefix !== 'string') return '';
  return prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '') // Keep alphanumeric and spaces
    .substring(0, 128);
}

/**
 * Returns the Redis client mapped to the key according to consistent hashing
 */
export function getRedisClient(key) {
  const address = ring.get(key);
  if (!address) {
    throw new Error('Consistent hash ring failed to find a valid Redis node address.');
  }
  const client = redisClients[address];
  if (!client) {
    throw new Error(`No Redis client connection configured for address: ${address}`);
  }
  return { client, address };
}

/**
 * Helper to execute a Redis command across all nodes (useful for invalidate, flush or debug)
 */
export async function executeOnAllNodes(fn) {
  const results = {};
  for (const [address, client] of Object.entries(redisClients)) {
    try {
      results[address] = await fn(client);
    } catch (err) {
      logger.error(`Error executing Redis command on node ${address}:`, err.message);
      results[address] = null;
    }
  }
  return results;
}

export { ring };
export default redisClients;
