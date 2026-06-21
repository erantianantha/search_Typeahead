# SearchQL — Distributed Search Typeahead System

A high-performance, distributed search autocomplete suggestion engine designed to handle low-latency queries and high-throughput write submissions. 

Built using **React (Vite)** on the frontend, **Node.js (Express)** on the backend, a distributed cache routed via **consistent hashing (3-node Redis cluster)**, and **PostgreSQL** as the persistent storage layer.

---

## 📸 System Screenshots

### 1. Autocomplete Typeahead Suggestions
Suggestions trigger after typing at least 3 characters and render with their actual search count. Displays sliding cache status indicators (HIT/MISS) and latency in real-time.
![Autocomplete Suggestions](./screenshots/suggestions.png)

### 2. Search Submission (Dummy Response)
Submitting a query pushes the counter increment asynchronously to the `BatchWriter` queue buffer and immediately returns a dummy `"Searched"` message with queue statistics.
![Search Submission](./screenshots/search_submit.png)

### 3. Consistent Hashing Routing Visualizer
Calculates the MD5 Ketama hash ring position of search prefixes dynamically in the browser, showing key routing across cache Nodes A, B, and C.
![Consistent Hashing Visualizer](./screenshots/consistent_hashing.png)

### 4. Asynchronous Batch Writer Monitor
Buffers PostgreSQL writes and shows real-time stats including queue latency, total database write reduction, configuration constants, and successful flush history.
![Batch Writer Dashboard](./screenshots/batch_writer.png)

---

## 🏗️ System Architecture

![System Architecture Diagram](./screenshots/architecture_diagram.png)

### Component Breakdown
1. **React Frontend**: Debounces input requests (`220ms`), displays suggestion lists showing matching prefixes, navigates options via keyboard, and provides administrative visualizers (Cache monitoring, ring trace).
2. **Express Backend**: Hosts endpoints for fetching suggestions, submitting searches, and querying cluster nodes diagnostics.
3. **Consistent Hash Router**: Hashes cache keys (`suggest:<prefix>`) using MD5 Ketama hash ring with `160 vnodes` per physical server to distribute keys evenly among the Redis nodes.
4. **Redis Cache (3-node Cluster)**: Serves autocomplete lists with sub-10ms latency using Redis Sorted Sets (`ZSET`).
5. **Trending Service**: Recomputes suggestion rankings every 5 minutes by blending total database hits and recent hourly activity (tracked via Redis sliding window):
   $$\text{Score} = 0.7 \times \text{log\_normalized\_total} + 0.3 \times \text{normalized\_recency}$$
6. **Batch Writer Queue**: Prevents PostgreSQL write saturation by collecting searches in a buffer, aggregating counters, and performing bulk upserts (`INSERT ... ON CONFLICT DO UPDATE`) every **10 seconds** or when the buffer hits **1000 queries**.

---

## 🚀 Installation & Local Setup

### Prerequisites
* Docker & Docker Compose
* Node.js (v18+) & npm

### 1. Start Database & Cache Servers
Launch PostgreSQL and the 3 Redis instances using Docker:
```bash
docker-compose up -d
```
Verify the containers are healthy:
```bash
docker ps
```

### 2. Configure Environment variables
Ensure environment configurations match your ports. Create a `.env` file in the `backend/` directory:
```env
PORT=3001
NODE_ENV=development
DATABASE_URL=postgresql://typeahead_user:typeahead_password@localhost:5433/typeahead
REDIS_NODES=127.0.0.1:6379,127.0.0.1:6380,127.0.0.1:6381
SUGGEST_CACHE_TTL=300
BATCH_FLUSH_INTERVAL_MS=10000
BATCH_MAX_SIZE=1000
BATCH_QUEUE_LIMIT=10000
TRENDING_CRON_INTERVAL_MS=300000
TRENDING_RECENCY_WEIGHT=0.3
TRENDING_TOTAL_WEIGHT=0.7
TRENDING_RECENCY_WINDOW_MINUTES=60
```

### 3. Load & Seed Dataset
This seeds the PostgreSQL database with **100,000+** queries mapping historical search counts and last-searched dates:
```bash
cd backend
npm install
npm run seed
```

### 4. Start Development Servers
**Start Backend Server:**
```bash
cd backend
npm run dev
```

**Start Frontend Server:**
```bash
cd ../frontend
npm install
npm run dev
```
Open `http://localhost:3002/` in your browser.

---

## 📡 API Specifications

### 1. `GET /suggest?q=<prefix>&limit=10`
* **Purpose**: Fetches up to 10 autocomplete suggestions matching the prefix.
* **Behavior**: Checks the mapped Redis node first (Cache HIT). If not found (Cache MISS), queries PostgreSQL, populates the Redis cache node, and returns the query.
* **Response**:
  ```json
  {
    "prefix": "iph",
    "cache_hit": true,
    "response_time_ms": 2,
    "suggestions": [
      { "query": "iphone", "score": 69.51, "count": 1363 },
      { "query": "iphone 20 price review free", "score": 66.55, "count": 107357 }
    ]
  }
  ```

### 2. `POST /search`
* **Purpose**: Submits a query. Returns a dummy response immediately and enqueues count updates.
* **Request**: `{ "query": "iphone 15" }`
* **Response**:
  ```json
  {
     "status": "Searched",
     "query": "iphone 15",
     "queued": true,
     "queue_size": 1,
     "timestamp": "2026-06-21T20:00:10.523Z"
  }
  ```

### 3. `GET /cache/status`
* **Purpose**: Scans all Redis cluster nodes and reports active keys, TTLs, and cardinality.

### 4. `GET /ring/trace?q=<prefix>`
* **Purpose**: Traces routing details, including MD5 key digests and physical node mapping.

---

## 📈 Performance Report

* **Latency**: 
  * Cache Hits: **< 5ms** (P99)
  * Cache Misses (with DB query): **< 50ms** (P95)
* **Write Reduction**: Pushing submissions to the `BatchWriter` queue limits database interactions to once every 10 seconds or 1000 submissions. During high traffic (e.g. 100 searches/sec), this results in a **~90% to 99% reduction in raw SQL write queries** through aggregation.
* **Cache Eviction**: 
  * **TTL Invalidation**: Key caching has a 300-second expiration. 
  * **Flush Invalidation**: To keep cache suggestions accurate, the `BatchWriter` actively deletes `suggest:<prefix>` keys from Redis for any query that was just flushed to PostgreSQL, purging empty miss sentinels (`__empty__`).

---

## ⚖️ Design Choices & Trade-offs

| Design Choice | Alternatives Considered | Trade-off / Justification |
|---------------|-------------------------|---------------------------|
| **Consistent Hashing (Ketama/MD5)** | Modulo-based partition | Modulo-based partition causes ~90% cache invalidation when cluster size changes. Consistent hashing relocates only $K/N$ keys. |
| **Batch Write Queue** | Synchronous DB writes | Direct writes saturate connection pools and spike CPU. Batching aggregates counts and flushes in bulk, reducing writes by 50-100x at the cost of eventual consistency (up to 10s lag). |
| **Cache-Aside Pattern** | Write-Through Cache | Write-through is expensive for cold keys. Cache-aside populates memory lazily on read demand, avoiding cache pollution. |
| **Log-Normalized Trending Scores** | Linear Count Score | Raw search count scales linearly, drowning out fresh searches. Logarithmic normalization compresses large numbers, allowing recent trends to compete. |
