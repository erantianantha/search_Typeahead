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

### 1. Architectural Blueprint
The system is divided into three distinct operational layers designed for extreme write reduction and microsecond reads.

![System Architecture Diagram](./screenshots/architecture_diagram.png)

### 2. High-Level Flow & Component Diagram
Below is the interactive technical flowchart illustrating the network boundaries, ports, protocols, and data pathways for both read and write paths.

```mermaid
flowchart TB
    %% Styling classes
    classDef clientStyle fill:#111827,stroke:#06b6d4,stroke-width:2px,color:#f9fafb,font-weight:bold;
    classDef serverStyle fill:#111827,stroke:#3b82f6,stroke-width:2px,color:#f9fafb,font-weight:bold;
    classDef cacheStyle fill:#111827,stroke:#10b981,stroke-width:2px,color:#f9fafb,font-weight:bold;
    classDef dbStyle fill:#111827,stroke:#f59e0b,stroke-width:2px,color:#f9fafb,font-weight:bold;

    subgraph ClientZone ["🌐 Client Layer (Web Browser)"]
        UI["React Search Component<br/>(Debounced input & 3-character threshold)"]:::clientStyle
        RingVis["Consistent Hash Ring Visualizer<br/>(MD5 Ketama Node Lookup)"]:::clientStyle
    end

    subgraph AppZone ["⚙️ Application Layer (Node.js/Express Server)"]
        API["Express Router & Controller"]:::serverStyle
        HashRouter["Consistent Hashing Router<br/>(160 Virtual Nodes per physical node)"]:::serverStyle
        BatchQueue["BatchWriter Queue Buffer<br/>(In-Memory array)"]:::serverStyle
    end

    subgraph CacheZone ["⚡ Distributed Cache Layer (Redis Cluster)"]
        RedisA["[(Redis Node A)]<br/>Port 6379<br/>(ZSET: suggest:*)"]:::cacheStyle
        RedisB["[(Redis Node B)]<br/>Port 6380<br/>(ZSET: suggest:*)"]:::cacheStyle
        RedisC["[(Redis Node C)]<br/>Port 6381<br/>(ZSET: suggest:*)"]:::cacheStyle
    end

    subgraph StorageZone ["💾 Persistent Database & Analytics Layer"]
        Postgres["[(PostgreSQL Database)]<br/>Port 5433<br/>(Index: idx_queries_text_score)"]:::dbStyle
        TrendingService["Trending Cron Job<br/>(Calculates score every 5m)"]:::dbStyle
    end

    %% Read Path
    UI -- "GET /suggest?q=prefix (min 3 chars)" --> API
    API -- "1. Hashing Key suggest:prefix" --> HashRouter
    HashRouter -- "2. Lookup Cache" --> RedisA
    HashRouter -- "2. Lookup Cache" --> RedisB
    HashRouter -- "2. Lookup Cache" --> RedisC

    RedisA -.->|Cache HIT| API
    RedisB -.->|Cache HIT| API
    RedisC -.->|Cache HIT| API

    API -- "3. Cache MISS (Fallback Select)" --> Postgres
    Postgres -- "4. Return database results" --> API
    API -- "5. Set cache (TTL = 300s)" --> HashRouter

    %% Write Path
    UI -- "POST /search {query}" --> API
    API -- "Immediate 'Searched' 200 OK Response" --> UI
    API -- "Enqueue update in memory" --> BatchQueue
    BatchQueue -- "Bulk Upsert (every 10s or 1000 items)" --> Postgres
    BatchQueue -- "Flush Invalidation (Delete suggest:prefix)" --> HashRouter

    %% Analytics & Trending Path
    TrendingService -- "1. Read total counts & hourly window" --> Postgres
    TrendingService -- "2. Calculate formula score" --> Postgres
    TrendingService -- "3. Write rankings back to cache nodes" --> HashRouter
```

### 3. Component Deep Dive
1. **React Frontend**: Captures input queries, enforces a **3-character minimum** to avoid caching single/double character prefixes, triggers requests with a **220ms debounce**, handles navigation using keyboard arrows/Enter, and visualizes MD5 Ketama hash ring mappings dynamically.
2. **Express Backend**: Hosts endpoints for fetching suggestions (`GET /suggest`), registering searches (`POST /search`), and exposing administrative diagnostics (/cache/status, /ring/trace).
3. **Consistent Hash Router**: Uses a Ketama hashing implementation with **160 virtual nodes** per physical cache instance. This ensures query prefixes (`suggest:<prefix>`) are evenly distributed and minimizes cache keys displacement during scale events.
4. **Redis Cache (3-node Cluster)**: Configured as individual nodes listening on ports `6379`, `6380`, and `6381`. It stores query prefix lists as Redis Sorted Sets (`ZSET`), allowing rapid autocomplete suggestion retrieval ranked by score.
5. **Trending Service**: A node-cron scheduler executing every 5 minutes that fetches raw counts and hourly decay metrics from PostgreSQL, computes updated popularity-time scores, and populates physical Redis cluster nodes.
6. **Batch Writer Queue**: Prevents PostgreSQL connection pool exhaustion by capturing write transactions in an in-memory buffer. It flushes batched upserts (`INSERT ... ON CONFLICT DO UPDATE`) every **10 seconds** or when the buffer size reaches **1000 items**, achieving up to a **99% write reduction**.
7. **Cache Invalidation Handler**: On successful database flushes, the Batch Writer identifies the prefixes of all updated queries and explicitly deletes their `suggest:<prefix>` cache keys in Redis. This invalidates stale Negative Cache (`__empty__` sentinels) immediately, ensuring immediate availability of new searches.

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
