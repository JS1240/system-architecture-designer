# System Design Primer: Knowledge Base Extract

Adapted from [system-design-primer](https://github.com/donnemartin/system-design-primer) by Donne Martin, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: condensed into tagged entries with source line ranges. This file is under CC BY 4.0, not the MIT License of this repository.

Source path legend: `R` = system-design-primer-master/README.md; `S/<name>` = system-design-primer-master/solutions/system_design/<name>/README.md; `O/<name>` = system-design-primer-master/solutions/object_oriented_design/<name>/. Line ranges are 1-based and inclusive.
Tags used in entries: `[src]` = stated in source, `[inf]` = inferred by the extractor, not stated in source.

## 1. Overview

- Donne Martin's System Design Primer (CC BY 4.0): a catalog of scalability building blocks (DNS, CDN, LB, proxy, DB scaling, NoSQL, cache, queues, protocols) plus 8 worked system design solutions and 6 OOD exercises.
- Core method: scope use cases and constraints, back-of-envelope math, high-level design, core components, then scale iteratively (benchmark, profile, fix bottleneck, repeat). Thesis: "everything is a trade-off" (R:408).
- Reference numbers: latency table, powers of two, availability nines, and the request-rate conversion (400 req/s = 1B req/month) reused across all solutions.

## 2. Topic index

| Topic | File:lines |
|---|---|
| Index of topics | R:89-181 |
| Study guide | R:182-217 |
| Interview approach (4 steps) | R:218-286 |
| Solutions table | R:287-352 |
| OOD questions table | R:353-371 |
| Start here (scalability lecture/article) | R:372-411 |
| Performance vs scalability | R:412-425 |
| Latency vs throughput | R:426-437 |
| CAP theorem (CP, AP) | R:438-472 |
| Consistency patterns (weak, eventual, strong) | R:473-498 |
| Availability patterns: fail-over active-passive/active-active | R:499-525 |
| Replication pointer | R:526-534 |
| Availability in numbers (9s, sequence vs parallel) | R:535-580 |
| DNS | R:581-618 |
| CDN (push, pull) | R:619-659 |
| Load balancer, L4, L7 | R:660-702 |
| Horizontal scaling | R:703-713 |
| LB disadvantages | R:714-729 |
| Reverse proxy, LB vs reverse proxy | R:730-772 |
| Application layer, microservices, service discovery | R:773-807 |
| RDBMS, ACID | R:808-828 |
| Master-slave replication | R:829-843 |
| Master-master replication | R:844-860 |
| Replication disadvantages | R:861-873 |
| Federation | R:874-894 |
| Sharding | R:895-922 |
| Denormalization | R:923-940 |
| SQL tuning | R:941-990 |
| NoSQL, BASE | R:991-1002 |
| Key-value store | R:1003-1019 |
| Document store | R:1020-1038 |
| Wide column store | R:1039-1061 |
| Graph database | R:1062-1089 |
| SQL or NoSQL | R:1090-1131 |
| Cache layers (client, CDN, web server, DB, application) | R:1132-1177 |
| Cache at query level vs object level | R:1178-1198 |
| Cache-aside | R:1203-1238 |
| Write-through | R:1239-1273 |
| Write-behind (write-back) | R:1274-1291 |
| Refresh-ahead | R:1292-1307 |
| Cache disadvantages | R:1308-1323 |
| Asynchronism, message queues | R:1324-1348 |
| Task queues | R:1349-1354 |
| Back pressure | R:1355-1369 |
| HTTP | R:1378-1401 |
| TCP | R:1402-1425 |
| UDP | R:1426-1454 |
| RPC | R:1455-1503 |
| REST | R:1504-1532 |
| RPC vs REST comparison table | R:1533-1559 |
| Security | R:1560-1576 |
| Powers of two table | R:1581-1599 |
| Latency numbers | R:1600-1647 |
| Additional interview questions | R:1648-1678 |
| Real world architectures | R:1679-1718 |
| Company architectures | R:1719-1746 |
| Under development (MapReduce, consistent hashing, scatter gather) | R:1800-1808 |
| Solution: Pastebin / Bit.ly | S/pastebin:1-333 |
| Solution: Twitter timeline and search | S/twitter:1-334 |
| Solution: Web crawler | S/web_crawler:1-353 |
| Solution: Mint.com | S/mint:1-441 |
| Solution: Social graph | S/social_graph:1-349 |
| Solution: Query cache (KV cache for search) | S/query_cache:1-306 |
| Solution: Amazon sales rank | S/sales_rank:1-338 |
| Solution: Scaling on AWS to millions of users | S/scaling_aws:1-403 |
| OOD: call_center, deck_of_cards, hash_table, lru_cache, online_chat, parking_lot | O/* (*.py + *.ipynb) |

## 3. Building blocks

Entry schema: def / use / avoid / pros / cons / alt / nums / src.

### 3.1 Performance vs scalability
- def: A service is scalable if performance rises proportionally to resources added (more units of work or larger units of work). Performance problem = slow for a single user. Scalability problem = fast for one user, slow under heavy load.
- use: Diagnose which problem you have before picking a fix. [inf]
- avoid: n/a.
- pros/cons: n/a (diagnostic concept).
- alt: n/a.
- nums: none.
- src: R:412-425

### 3.2 Latency vs throughput
- def: Latency = time to perform an action. Throughput = actions per unit time.
- use: Target maximal throughput with acceptable latency.
- avoid: n/a.
- nums: see section 4.
- src: R:426-437

### 3.3 CAP theorem
- def: In a distributed system pick 2 of: Consistency (every read gets most recent write or error), Availability (every request gets a response, possibly stale), Partition tolerance (operates despite network partitions). Networks are unreliable, so P is mandatory; real trade-off is C vs A.
- CP: waiting on partitioned node may time out. use when business needs atomic reads and writes.
- AP: returns most readily available version, may be stale; writes propagate after partition heals. use when eventual consistency is acceptable or system must keep working despite external errors.
- avoid: CP when availability under partition is a hard requirement; AP when reads must be linearizable. [inf]
- alt: BASE (NoSQL) chooses A over C (R:995).
- src: R:438-472

### 3.4 Consistency patterns
- Weak: after write, reads may or may not see it; best effort. Examples: memcached, VoIP, video chat, realtime multiplayer games. use for realtime where lost data is acceptable.
- Eventual: reads eventually see write (typically within ms); async replication. Examples: DNS, email. use for highly available systems.
- Strong: reads see write immediately; sync replication. Examples: file systems, RDBMS. use for systems needing transactions.
- cons: strong costs latency/availability; eventual allows stale reads. [inf]
- src: R:473-498

### 3.5 Availability patterns: fail-over
- Active-passive (master-slave failover): heartbeats between active and standby; on heartbeat loss passive takes over active's IP. Downtime depends on hot vs cold standby. Only active serves traffic.
- Active-active (master-master failover): both serve traffic and share load. Public-facing: DNS must know both public IPs. Internal: app logic must know both.
- use: any component that must not be a single point of failure (LBs, DBs, reverse proxies).
- cons: more hardware and complexity; data loss possible if active fails before new writes replicate to passive.
- alt: replication (complementary pattern).
- src: R:499-525

### 3.6 Availability patterns: replication
- def: master-slave and master-master; details under 3.15 and 3.16.
- src: R:526-534

### 3.7 Availability in numbers
- 99.9% (three 9s): year 8h 45min 57s; month 43m 49.7s; week 10m 4.8s; day 1m 26.4s.
- 99.99% (four 9s): year 52min 35.7s; month 4m 23s; week 1m 5s; day 8.6s.
- In sequence: A_total = A_foo * A_bar. 99.9% and 99.9% -> 99.8%.
- In parallel: A_total = 1 - (1 - A_foo) * (1 - A_bar). 99.9% and 99.9% -> 99.9999%.
- use: every added serial hop lowers availability; redundancy in parallel raises it.
- src: R:535-580

### 3.8 DNS
- def: translates domain name to IP. Hierarchical; few authoritative top-level servers; lower-level servers and browser/OS cache results per TTL.
- records: NS (name servers for domain), MX (mail servers), A (name -> IP), CNAME (name -> name or A record).
- routing (managed DNS e.g. CloudFlare, Route 53): weighted round robin (drain servers under maintenance, balance unequal cluster sizes, A/B testing), latency-based, geolocation-based.
- use: always, for name resolution; also for coarse traffic steering and active-active failover across public IPs.
- cons: lookup adds slight delay (mitigated by caching); stale mappings due to propagation delay; management complexity (governments, ISPs, large companies); DDoS target (Dyn attack, Oct 2016).
- alt: crawler-local DNS cache refreshed periodically when DNS lookup is a bottleneck (S/web_crawler:286).
- src: R:581-618

### 3.9 CDN (push and pull)
- def: globally distributed proxy servers serving content near users. Typically static (HTML/CSS/JS, photos, video); some (CloudFront) support dynamic. DNS resolution tells client which CDN server to use.
- pros: content served from nearby data center; origin servers skip requests the CDN fulfills.
- Push CDN: you upload to CDN on change and rewrite URLs; you control expiry and update. Minimizes traffic, maximizes storage. use: small-traffic sites or rarely-updated content.
- Pull CDN: CDN fetches from origin on first request; TTL controls cache lifetime. First request slower. Minimizes CDN storage, can cause redundant traffic if files expire before changing. use: heavy-traffic sites (only recently requested content stays).
- cons: cost can be significant (weigh against cost of not using one); stale content until TTL expiry; URLs for static content must change to point to CDN.
- alt: reverse proxy / web server caching; object store (S3) as origin.
- src: R:619-659

### 3.10 Load balancer
- def: distributes client requests to compute resources (app servers, DBs) and returns responses. Hardware (expensive) or software (HAProxy).
- pros: blocks requests to unhealthy servers; prevents overload; helps remove SPOF; SSL termination (no X.509 cert per backend); session persistence via cookies when apps do not track sessions.
- routing: random, least loaded, session/cookies, round robin, weighted round robin, L4, L7.
- HA: multiple LBs in active-passive or active-active.
- cons: can bottleneck if under-resourced or misconfigured; adds complexity; single LB is a SPOF, multiple LBs add more complexity.
- alt: DNS round robin [inf]; reverse proxy for single server.
- src: R:660-702, R:714-729

### 3.11 Layer 4 vs Layer 7 load balancing
- L4: decides on transport-layer info (src/dst IP, ports), not packet contents; forwards packets with NAT. Less time and compute.
- L7: decides on application layer (headers, message, cookies); terminates traffic, reads message, opens new connection to chosen server. Example: route video to video hosts, billing to security-hardened hosts.
- trade-off: L4 cheaper and faster, L7 more flexible; performance gap minimal on modern commodity hardware.
- src: R:693-702

### 3.12 Horizontal scaling
- def: scale out with commodity machines behind LB.
- pros vs vertical: more cost efficient, higher availability, easier hiring than for specialized enterprise systems.
- requires: stateless servers (no sessions or profile pictures on box); sessions in central store (SQL, NoSQL, Redis, Memcached).
- cons: complexity, cloning servers; downstream caches/DBs must handle more concurrent connections.
- alt: vertical scaling (bigger box): simple, but expensive and no redundancy/failover (S/scaling_aws:88-99).
- src: R:703-713

### 3.13 Reverse proxy (web server)
- def: web server that centralizes internal services and gives unified public interface; forwards requests to a backend and returns its response.
- pros: security (hide backends, IP blacklist, per-client connection limits); scalability/flexibility (clients see only proxy IP); SSL termination; compression; caching; serve static content directly.
- LB vs reverse proxy: LB useful with multiple servers of same function; reverse proxy useful even with one server; NGINX and HAProxy do both (L7 proxy + LB).
- cons: complexity; single proxy is SPOF; multiple proxies (failover) add complexity.
- src: R:730-772

### 3.14 Application layer, microservices, service discovery
- def: separate web layer from application (platform) layer so each scales and is configured independently; new API = add app servers without adding web servers. Single responsibility principle: small autonomous services. App-layer workers enable asynchronism.
- Microservices: independently deployable, small, modular services, each its own process, lightweight communication, one business goal. Example (Pinterest): user profile, follower, feed, search, photo upload.
- Service discovery: Consul, Etcd, Zookeeper track registered names, addresses, ports. Health checks usually via HTTP endpoint. Consul and Etcd include KV store for config/shared data.
- use: growth requiring independent scaling; small teams owning small services.
- cons: needs different architecture, ops, and process vs monolith; microservices add deployment and operations complexity.
- alt: monolith. [inf for naming as alternative; source contrasts with "monolithic system"]
- src: R:773-807

### 3.15 RDBMS and ACID
- def: tables of data items. ACID: Atomicity (all or nothing), Consistency (valid state to valid state), Isolation (concurrent = serial result), Durability (committed stays committed).
- scaling techniques: master-slave replication, master-master replication, federation, sharding, denormalization, SQL tuning.
- src: R:816-828

### 3.16 Master-slave replication
- def: master serves reads and writes, replicates writes to slaves that serve reads only; slaves can replicate to more slaves (tree). If master dies: read-only mode until a slave is promoted or new master provisioned.
- use: read-heavy workloads (most services; reads outnumber writes 100:1 to 1000:1, R:929).
- cons: extra logic to promote slave; plus shared replication cons (3.18).
- alt: master-master; memory cache in front of DB; federation/sharding.
- src: R:829-843

### 3.17 Master-master replication
- def: both masters serve reads and writes and coordinate writes; either can fail and system keeps reads and writes.
- use: write availability during a master failure. [inf]
- cons: need LB or app logic to choose write target; most systems are loosely consistent (violate ACID) or have higher write latency from sync; conflict resolution grows with more write nodes and higher latency; plus shared replication cons.
- src: R:844-860

### 3.18 Replication disadvantages (both modes)
- Data loss if master fails before new writes replicate.
- Writes replayed on replicas; heavy writes bog replicas, fewer reads served.
- More read slaves = more replication = more replication lag.
- Master may write with parallel threads; replicas often apply writes sequentially single-threaded.
- More hardware and complexity.
- src: R:861-873

### 3.19 Federation (functional partitioning)
- def: split DBs by function, e.g. forums, users, products.
- pros: less read/write traffic per DB, less replication lag; smaller DBs fit in memory -> more cache hits; no single central master serializing writes -> parallel writes, higher throughput.
- avoid: schema requires huge functions or tables.
- cons: app logic must route reads/writes to right DB; cross-DB joins need server link; more hardware and complexity.
- alt: sharding (split by row instead of by function).
- src: R:874-894

### 3.20 Sharding
- def: distribute data across DBs so each holds a subset (e.g. users); add shards as users grow. Common keys: last name initial, geographic location.
- pros: same as federation (less traffic, less replication, more cache hits) plus smaller indexes -> faster queries; one shard down leaves others up (add replication to avoid data loss); parallel writes.
- cons: app logic must be shard-aware, complex SQL; lopsided distribution (power users on one shard); rebalancing complexity (consistent hashing reduces data moved); cross-shard joins complex; more hardware and complexity.
- alt: federation, denormalization, NoSQL (natively partitioned [inf]).
- used in: social_graph Person Servers (by location), query_cache cluster (hash(query)), web_crawler indexes.
- src: R:895-922

### 3.21 Denormalization
- def: improve reads at expense of writes by writing redundant copies into multiple tables to avoid expensive joins. PostgreSQL and Oracle materialized views maintain redundant copies.
- use: read-heavy systems (reads 100:1 to 1000:1); after federation/sharding when cross-DC joins are costly.
- cons: duplicated data; constraints to keep copies in sync increase design complexity; under heavy write load may perform worse than normalized.
- src: R:923-940

### 3.22 SQL tuning
- method: benchmark (simulate load with `ab`) and profile (slow query log).
- schema: MySQL dumps to disk in contiguous blocks; CHAR over VARCHAR for fixed-length fields (fast random access); TEXT for large text (pointer on disk, boolean search); INT up to 2^32 (~4 billion); DECIMAL for currency; avoid large BLOBs, store object location; VARCHAR(255) = max countable in 8-bit number; NOT NULL improves search performance.
- indices: index columns used in SELECT, GROUP BY, ORDER BY, JOIN; B-tree, log-time search/insert/delete; costs memory; slows writes; for bulk loads disable indices, load, rebuild.
- avoid expensive joins: denormalize where performance demands.
- partition tables: move hot spots to separate table to keep in memory.
- query cache: can cause performance issues in some cases.
- src: R:941-990

### 3.23 NoSQL general and BASE
- def: KV, document, wide column, or graph stores. Data denormalized; joins in application code; most lack true ACID; favor eventual consistency.
- BASE: Basically available; Soft state (state may change without input); Eventual consistency.
- src: R:991-1002

### 3.24 Key-value store
- abstraction: hash table. O(1) reads/writes, memory or SSD backed. Some keep keys in lexicographic order (range scans). Metadata with values.
- use: simple data models, rapidly-changing data, in-memory cache layer.
- cons: limited operations, complexity pushed to app layer.
- note: basis for document stores and some graph DBs.
- examples: Redis, Memcached.
- src: R:1003-1019

### 3.25 Document store
- abstraction: KV with documents (XML, JSON, binary) as values; one document holds all info for an object. Query by internal document structure. Organized by collections, tags, metadata, directories; docs in a group may have different fields.
- examples: MongoDB, CouchDB (SQL-like query language), DynamoDB (KV and document), Elasticsearch (further reading).
- use: occasionally changing data, high flexibility.
- src: R:1020-1038

### 3.26 Wide column store
- abstraction: nested map `ColumnFamily<RowKey, Columns<ColKey, Value, Timestamp>>`. Unit = column (name/value); column families (~SQL table); super column families; access columns by row key; timestamp per value for versioning and conflict resolution.
- examples: Bigtable (first), HBase (Hadoop), Cassandra (Facebook); lexicographic key order -> efficient key range retrieval.
- use: very large data sets; high availability and scalability.
- src: R:1039-1061

### 3.27 Graph database
- abstraction: graph; node = record, arc = relationship. Optimized for many foreign keys / many-to-many relationships.
- use: complex relationships, e.g. social network.
- cons: relatively new, less widely used, fewer tools/resources; many only accessible via REST.
- examples: Neo4j, FlockDB.
- alt: sharded KV + BFS in app (S/social_graph excludes graph DBs by constraint).
- src: R:1062-1089

### 3.28 SQL vs NoSQL
- SQL reasons: structured data, strict schema, relational data, complex joins, transactions, clear scaling patterns, mature ecosystem, fast index lookups.
- NoSQL reasons: semi-structured data, dynamic/flexible schema, non-relational data, no complex joins, many TB or PB, very data-intensive workload, very high IOPS throughput.
- NoSQL-fit data: rapid ingest of clickstream and logs, leaderboards/scoring, temporary data (shopping cart), hot tables, metadata/lookup tables.
- default in solutions: start with SQL (scaling_aws assumes relational need), move hot or high-volume data to NoSQL later.
- src: R:1090-1131

### 3.29 Cache layers
- def: return previous result instead of re-executing; absorbs uneven load and traffic spikes on popular items that skew DB partition distribution.
- Client caching: OS or browser.
- CDN caching: CDN is a cache.
- Web server caching: reverse proxies and Varnish serve static and dynamic content; web servers cache requests without hitting app servers.
- Database caching: default DB cache, tune for usage pattern. scaling_aws: try MySQL cache config before adding memory cache (S/scaling_aws:237).
- Application caching: Memcached, Redis in RAM between app and storage; LRU evicts cold entries. Redis adds persistence and data structures (sorted sets, lists).
- levels: row, query, fully-formed serializable objects, fully-rendered HTML.
- avoid: file-based caching (hinders cloning and autoscaling).
- src: R:1132-1177

### 3.30 Query-level vs object-level caching
- Query-level: hash query as key, store result. cons: hard to delete results of complex queries; one changed cell invalidates all queries that might include it.
- Object-level: cache assembled objects/data structures; remove object when underlying data changes; enables async workers that assemble objects from latest cached object.
- what to cache: user sessions, fully rendered pages, activity streams, user graph data.
- src: R:1178-1198

### 3.31 Cache-aside (lazy loading)
- def: app reads cache; on miss loads from DB, writes to cache, returns. Cache never talks to storage. Memcached typical.
- pros: subsequent reads fast; only requested data cached.
- cons: each miss = 3 trips (noticeable delay); stale data if DB updated (mitigate with TTL or write-through); failed node replaced by empty node -> higher latency.
- used in: mint read path (S/mint:356-370), query_cache (S/query_cache:209).
- src: R:1203-1238

### 3.32 Write-through
- def: app reads/writes cache as main store; cache synchronously writes to DB, then returns.
- pros: data in cache not stale; reads of just-written data fast; users tolerate write latency more than read latency.
- cons: slow writes overall; new node (failure or scaling) caches nothing until entries updated (mitigate by combining with cache-aside); most written data may never be read (mitigate with TTL).
- src: R:1239-1273

### 3.33 Write-behind (write-back)
- def: app writes cache; cache writes to DB asynchronously.
- pros: better write performance.
- cons: data loss if cache dies before flush; more complex than cache-aside or write-through.
- src: R:1274-1291

### 3.34 Refresh-ahead
- def: cache auto-refreshes recently accessed entries before expiration.
- pros: lower latency than read-through if predictions are accurate.
- cons: wrong predictions reduce performance below no refresh-ahead.
- src: R:1292-1307

### 3.35 Cache disadvantages (general)
- Must keep cache and source of truth consistent via invalidation; invalidation is hard; app changes required (add Redis/Memcached).
- src: R:1308-1323

### 3.36 Message queues
- def: receive, hold, deliver messages. Flow: app publishes job and notifies user of status; worker processes job and signals completion. User not blocked; client may fake completion (tweet appears on own timeline before fanout).
- options: Redis (simple broker, messages can be lost); RabbitMQ (popular, AMQP, self-managed nodes); Amazon SQS (hosted, can have high latency, possible duplicate delivery).
- use: operations too slow inline; periodic precomputation (aggregation).
- avoid: inexpensive calculations and realtime workflows (queues add delay and complexity).
- used in: mint transaction extraction, twitter notifications, web_crawler index/document jobs, scaling_aws thumbnail jobs.
- src: R:1324-1348, R:1359-1362

### 3.37 Task queues
- def: receive tasks plus data, run them, deliver results; support scheduling; for compute-heavy background jobs.
- example: Celery (scheduling, mainly Python).
- src: R:1349-1354

### 3.38 Back pressure
- def: limit queue size so it does not exceed memory (which causes cache misses, disk reads, slowdown); keeps throughput and response times for queued jobs. When full, clients get server busy / HTTP 503 and retry later, possibly with exponential backoff.
- related: Little's law (further reading).
- src: R:1355-1358

### 3.39 HTTP
- def: request/response protocol for encoding and transporting data client-server; self-contained, passes through intermediaries doing LB, caching, encryption, compression. Application layer on top of TCP/UDP.
- verbs: GET (read; idempotent yes, safe yes, cacheable yes); POST (create or trigger process; no, no, cacheable if response has freshness info); PUT (create or replace; idempotent yes, safe no, not cacheable); PATCH (partial update; no, no, cacheable if freshness info); DELETE (delete; idempotent yes, safe no, not cacheable).
- src: R:1378-1401

### 3.40 TCP
- def: connection-oriented over IP; handshake to open/close; ordered, uncorrupted delivery via sequence numbers, checksums, ACKs, retransmission; drops connection after repeated timeouts; flow control and congestion control.
- use: need all data intact; want automatic best use of network throughput. Examples: web servers, DB info, SMTP, FTP, SSH.
- cons: guarantees add delay, less efficient than UDP; many open connections = high memory; expensive web-server-thread-to-memcached connections (mitigate: connection pooling, UDP where applicable).
- src: R:1402-1425

### 3.41 UDP
- def: connectionless; datagram-level guarantee only; may arrive out of order or not at all; no congestion control; more efficient. Supports broadcast (used by DHCP).
- use: lowest latency; late data worse than lost data; you implement your own error correction. Examples: VoIP, video chat, streaming, realtime multiplayer games.
- cons: unreliable.
- used in: web_crawler optimization (S/web_crawler:288).
- src: R:1426-1454

### 3.42 RPC
- def: client executes procedure in remote address space coded like a local call. Flow: client program -> client stub marshals procedure id + args -> client comm module -> server comm module -> server stub unmarshals and calls -> response reverses. Frameworks: Protobuf, Thrift, Avro.
- focus: exposing behaviors. Often used internally for performance (hand-crafted native calls).
- use (native library/SDK): known target platform; control how logic is accessed; control error handling; performance and UX primary.
- cons: clients tightly coupled to service implementation; new API per operation/use case; hard to debug; existing tech (e.g. Squid caching) may not work out of the box.
- src: R:1455-1503

### 3.43 REST
- def: architectural style, client acts on server-managed resources; stateless and cacheable. Four qualities: identify resources (URI), change with representations (verbs, headers, body), self-descriptive errors (status codes), HATEOAS (browsable).
- focus: exposing data; minimizes client/server coupling; used for public HTTP APIs; stateless -> good for horizontal scaling and partitioning.
- cons: poor fit for resources not in a simple hierarchy (e.g. all records updated in past hour matching events); few verbs may not fit (move expired docs to archive); nested resources need multiple round trips (bad on mobile); response bloat as fields are added for all clients.
- RPC vs REST examples: signup POST /signup vs POST /persons; resign POST /resign vs DELETE /persons/1234; read GET /readPerson?personid=1234 vs GET /persons/1234; items list GET /readUsersItemsList?personid=1234 vs GET /persons/1234/items; add item POST /addItemToUsersItemsList vs POST /persons/1234/items; update POST /modifyItem vs PUT /items/456; delete POST /removeItem vs DELETE /items/456.
- solutions convention: public REST API externally, RPC internally.
- src: R:1504-1559

### 3.44 Security
- basics: encrypt in transit and at rest; sanitize all user inputs to prevent XSS and SQL injection; parameterized queries against SQL injection; least privilege. Section flagged by author as needing updates.
- applied (scaling_aws): open only ports 80, 443, and 22 (SSH from whitelisted IPs only); block outbound connections from web server; VPC with public subnet for web server and private subnet for everything else; whitelist IPs per component (S/scaling_aws:123-134, 179-186).
- further reading: API security checklist, security guide for developers, OWASP top ten.
- src: R:1560-1576

## 4. Numbers

### 4.1 Latency numbers every programmer should know (R:1600-1626)

| Operation | ns | us | ms | Note |
|---|---|---|---|---|
| L1 cache reference | 0.5 | | | |
| Branch mispredict | 5 | | | |
| L2 cache reference | 7 | | | 14x L1 |
| Mutex lock/unlock | 25 | | | |
| Main memory reference | 100 | | | 20x L2, 200x L1 |
| Compress 1 KB with Zippy | 10,000 | 10 | | |
| Send 1 KB over 1 Gbps network | 10,000 | 10 | | |
| Read 4 KB randomly from SSD | 150,000 | 150 | | ~1 GB/s SSD |
| Read 1 MB sequentially from memory | 250,000 | 250 | | |
| Round trip within same datacenter | 500,000 | 500 | | |
| Read 1 MB sequentially from SSD | 1,000,000 | 1,000 | 1 | ~1 GB/s SSD, 4x memory |
| HDD seek | 10,000,000 | 10,000 | 10 | 20x DC round trip |
| Read 1 MB sequentially from 1 Gbps | 10,000,000 | 10,000 | 10 | 40x memory, 10x SSD |
| Read 1 MB sequentially from HDD | 30,000,000 | 30,000 | 30 | 120x memory, 30x SSD |
| Send packet CA -> Netherlands -> CA | 150,000,000 | 150,000 | 150 | |

Units: 1 ns = 1e-9 s; 1 us = 1e-6 s = 1,000 ns; 1 ms = 1e-3 s = 1,000 us = 1,000,000 ns.

Derived throughput (R:1628-1635): HDD sequential 30 MB/s; 1 Gbps Ethernet 100 MB/s; SSD 1 GB/s; main memory 4 GB/s; 6-7 world-wide round trips per second; 2,000 round trips per second within a data center.

Note: solutions repeat "1 MB from memory 250 us, SSD 4x, disk 80x" (e.g. S/scaling_aws:240, S/pastebin:119). The table gives disk = 120x memory; the 80x figure is inconsistent with the table. [inf]

### 4.2 Powers of two (R:1581-1594)

| Power | Exact | Approx | Bytes |
|---|---|---|---|
| 7 | 128 | | |
| 8 | 256 | | |
| 10 | 1,024 | 1 thousand | 1 KB |
| 16 | 65,536 | | 64 KB |
| 20 | 1,048,576 | 1 million | 1 MB |
| 30 | 1,073,741,824 | 1 billion | 1 GB |
| 32 | 4,294,967,296 | | 4 GB |
| 40 | 1,099,511,627,776 | 1 trillion | 1 TB |

### 4.3 Back-of-envelope rules (every solution, e.g. S/scaling_aws:56-61)
- 2.5 million seconds per month.
- 1 req/s = 2.5 million req/month.
- 40 req/s = 100 million req/month.
- 400 req/s = 1 billion req/month.
- Conversion used: rate_per_s = monthly_count * (400 / 1e9).
- Storage: size_per_item * items_per_month; multiply by 36 for 3 years.
- Reads typically outnumber writes 100:1 to 1000:1 (R:929).
- Availability nines: see 3.7.
- Interview requirement questions (R:226-237): who uses it, how, how many users, what it does, inputs/outputs, data volume, requests per second, read:write ratio.

## 5. System design solutions

### 5.1 Pastebin / Bit.ly (S/pastebin)
- use cases (19-28): user enters text, gets random link (default no expiry, optional timed expiry); user views paste by URL; anonymous users; monthly visit analytics; delete expired pastes; high availability. Out of scope (30-37): accounts, email verify, login, edit, visibility, custom shortlink.
- constraints (41-50): uneven traffic; following short link must be fast; text only; analytics not realtime; 10M users; 10M paste writes/month; 100M reads/month; 10:1 read:write.
- math (56-69): per paste 1 KB content + shortlink 7 B + expiration 4 B + created_at 5 B + paste_path 255 B = ~1.27 KB; 12.7 GB/month; ~450 GB in 3 years; 360M shortlinks in 3 years; 4 writes/s; 40 reads/s.
- components: Client, Web Server (reverse proxy), Write API, Read API, SQL DB (`pastes` table), Object Store (S3) for paste content, Analytics DB (Redshift/BigQuery), Memory Cache, SQL read replicas, SQL write master-slave, LB, CDN, DNS.
- write path (96-105): web server -> Write API -> generate URL, check SQL for duplicate, regenerate on collision -> insert `pastes` row -> store content in object store -> return URL.
- schema (111-117): shortlink char(7) PK, expiration_length_in_minutes int, created_at datetime, paste_path varchar(255); extra index on created_at.
- URL generation (121-147): MD5(ip_address + timestamp) (128-bit, uniform) or MD5 of random data; Base62 encode (`[a-zA-Z0-9]`, URL-safe, deterministic; Base64 rejected for `+` and `/`); take first 7 chars -> 62^7 (~3.5 trillion [inf: arithmetic]) values, enough for 360M.
- API: REST POST /api/v1/paste {expiration_length_in_minutes, paste_contents} -> {shortlink}; GET /api/v1/paste?shortlink=... ; RPC internally.
- read path (168-173): Read API checks SQL for URL; if present fetch content from object store, else error.
- analytics (193-228): MapReduce over web server logs, key (year-month, url) -> count.
- expiry (232): scan SQL for expired timestamps, delete or mark expired.
- scaling (240-276): iterate (benchmark, profile, fix, repeat); object store handles 12.7 GB/month; memory cache for popular content and spikes; read replicas handle misses if not bogged by replication; 4 writes/s fine for single SQL write master-slave, else federation, sharding, denormalization, SQL tuning, or NoSQL. Alternatives to SQL-as-hash-table: NoSQL KV store, NoSQL document store (90-94).

### 5.2 Twitter timeline and search (S/twitter)
- use cases (19-24): post tweet (fanout to followers, push notifications, emails); view user timeline; view home timeline; keyword search; HA. Out of scope (28-32): firehose, visibility filtering, analytics.
- constraints (40-61): uneven traffic; posting fast; fanout fast unless millions of followers; 100M active users; 500M tweets/day = 15B/month; avg fanout 10 -> 5B deliveries/day, 150B/month; 250B reads/month; 10B searches/month; timeline and search read-heavy; ingest write-heavy.
- math (67-83): tweet_id 8 B, user_id 32 B, text 140 B, media 10 KB avg -> ~10 KB; 150 TB/month; 5.4 PB in 3 years; 100K reads/s; 6,000 tweets/s; 60K fanout deliveries/s; 4,000 searches/s.
- components: Client, Web Server (reverse proxy), Write API, Read API, Search API, Fan Out Service, User Graph Service, Timeline Service, Tweet Info Service, User Info Service, Search Service + Search Cluster (Lucene), Notification Service + Queue, Memory Cache (Redis), SQL DB (user timeline), Object Store (media), LB, CDN, DNS, read replicas.
- post path (110-120): Write API stores tweet in user timeline (SQL) -> Fan Out Service: get followers from User Graph Service (memory cache), insert tweet into each follower's home timeline in memory cache (O(n), 1,000 followers = 1,000 lookups+inserts), index in Search Index Service, media to object store, notifications via queue.
- why not SQL for fanout (106): 60K deliveries/s would overload RDBMS; use NoSQL or memory cache with fast writes.
- Redis list entry (126-130): tweet_id 8 B + user_id 8 B + meta 1 B per entry.
- home timeline read (158-163): Timeline Service gets ids from memory cache O(1); multiget Tweet Info Service O(n); multiget User Info Service O(n).
- user timeline read (193-195): from SQL.
- search (201-212): parse/tokenize (strip markup, split terms, fix typos, normalize case, boolean ops); scatter-gather across search cluster; merge, rank, sort.
- scaling (251-277): fanout service bottleneck for users with millions of followers (minutes; race with @replies, fix by reordering at serve time); skip fanout for highly-followed users, merge their tweets via search at read time (hybrid push/pull); keep only several hundred tweets per home timeline in cache; cache only users active in past 30 days, rebuild others from SQL via User Graph Service; Tweet Info Service stores 1 month; User Info Service stores active users; search cluster in memory; read replicas insufficient for misses and single write master insufficient -> federation, sharding, denormalization, SQL tuning, NoSQL.

### 5.3 Web crawler (S/web_crawler)
- use cases (17-23): crawl URL list; build reverse index of words to pages; generate static titles and snippets; user searches and gets pages with titles/snippets (high level only); HA. Out of scope: search analytics, personalization, page rank.
- constraints (35-49): uneven traffic (some queries very popular); anonymous users; fast results; no infinite loops (graph cycles); 1B links; refresh ~weekly (popular sites more often) -> 4B crawls/month; 500 KB avg page; 100B searches/month; do not use Solr/Nutch.
- math (55-59): 2 PB stored/month; 72 PB in 3 years; 1,600 writes/s; 40,000 searches/s.
- components: Crawler Service, NoSQL KV DB (`links_to_crawl` as Redis sorted set ranked by popularity, `crawled_links` with page signatures), Reverse Index Service + queue, Document Service + queue, Query API, Web Server (reverse proxy), Memory Cache, LB, DNS.
- crawl loop (86-97): take top-ranked link; if `crawled_links` has similar signature, lower its priority (prevents cycles) and continue; else crawl, enqueue reverse-index job and document job, create signature, remove from `links_to_crawl`, insert into `crawled_links`.
- dedupe (181-202): URL dedupe via `sort | unique` for small lists, MapReduce emitting frequency==1 for 1B links; content dedupe via signature similarity (Jaccard index, cosine similarity).
- freshness (206-210): `timestamp` per crawl; default refresh 1 week, popular more often; mine mean time between page updates; honor robots.txt.
- query path (214-225): Query API parses query, Reverse Index Service finds and ranks docs, Document Service returns titles/snippets.
- scaling (281-289): memory cache for popular queries; Reverse Index and Document services need heavy sharding and federation; local DNS cache refreshed periodically; connection pooling; UDP may help; ensure bandwidth.

### 5.4 Mint.com (S/mint)
- use cases (17-27): connect financial account; extract transactions daily; categorize (manual override, no auto re-categorization); monthly spending by category; recommend budget; manual budget; notify near/over budget; HA.
- constraints (37-53): uneven traffic; daily auto-update only for users active in past 30 days; adding/removing accounts rare; notifications not instant; 10M users; 10 categories each = 100M budget items; 50,000 sellers; 30M accounts; 5B transactions/month; 500M reads/month; 10:1 WRITE:read (write-heavy).
- math (59-70): user_id 8 B, created_at 5 B, seller 32 B, amount 5 B -> ~50 B; 250 GB/month; 9 TB in 3 years; 2,000 tx writes/s; 200 reads/s.
- components: Client, Web Server (reverse proxy), Accounts API, Queue (SQS/RabbitMQ), Transaction Extraction Service, Category Service, Budget Service, Notification Service + Queue, Object Store (raw transaction logs), SQL DB (`accounts`, `transactions`, `monthly_spending`, `budget_overrides`), Read API, Memory Cache, Analytics DB (Redshift/BigQuery), CDN, LB, DNS, read replicas.
- connect account (93-123): Accounts API writes `accounts` (id, created_at, last_update, account_url, account_login, account_password_hash char(64), user_id FK); index id, user_id, created_at.
- extraction (129-149): triggered on first link, manual refresh, daily for 30-day-active users; Accounts API enqueues job (async because extraction is slow); worker pulls, stores raw logs in object store, categorizes, budget service aggregates monthly spend and notifies, updates `transactions` and `monthly_spending`, notifies user via queue.
- category service (181-218): seller->category dict seeded with popular sellers (50,000 x <255 B ~ 12 MB); unknown sellers from crowdsourced user overrides, heap gives top override per seller in O(1).
- budget (233-264): generic template by income tier (e.g. housing 40%, food 20%, gas 10%, shopping 20%), store only overrides in `budget_overrides` instead of 100M items; aggregates via SQL on `transactions` or MapReduce over raw logs keyed (user_id, year-month, category) to offload DB.
- scaling (356-385): new use case user reads summaries; cache sessions, per-category aggregates, recent transactions in Redis/Memcached; static from S3 via CDN; cache-aside read path; move `monthly_spending` to Analytics DB; keep 1 month of `transactions` in SQL, rest in warehouse or object store (S3 handles 250 GB/month); read replicas handle misses; 2,000 writes/s may overwhelm single SQL write master-slave -> federation, sharding, denormalization, SQL tuning, NoSQL.

### 5.5 Social graph data structures (S/social_graph)
- use cases (17-18): user searches someone, sees shortest path; HA.
- constraints (24-32): uneven traffic; graph does not fit on one machine; unweighted edges; 100M users; 50 friends avg; 1B friend searches/month; no graph DB or GraphQL.
- math (38-40): 5B friend relationships; 400 searches/s.
- components: Client, Web Server (reverse proxy), Search API, User Graph Service, Lookup Service (person_id -> Person Server), Person Servers (sharded; person_id -> Person{id, name, friend_ids}), Memory Cache, NoSQL (precomputed traversals), LB, DNS.
- core algorithm (63-100, 163-219): BFS for unweighted shortest path; distributed version calls Lookup Service per adjacent node to locate its Person Server; visited set kept in service (not on node).
- scaling (274-285): cache person data (helps repeat searchers and well-connected users); cache complete/partial BFS traversals; batch-compute traversals offline into NoSQL; batch friend lookups per Person Server; shard Person Servers by location (friends live near each other); bidirectional BFS from source and destination; start from high-degree users; limit by time or hops then ask user; graph DB (Neo4j) or GraphQL if allowed.

### 5.6 Query cache: KV cache for search results (S/query_cache)
- use cases (17-19): search request cache hit; cache miss; HA.
- constraints (25-34): uneven traffic, popular queries almost always cached; need expire/refresh policy; fast lookups; low inter-machine latency; limited memory; cache millions of queries; 10M users; 10B queries/month.
- math (40-48): query 50 B + title 20 B + snippet 200 B = 270 B; 2.7 TB/month if all unique and stored (so must evict); 4,000 req/s.
- components: Client, Web Server (reverse proxy), Query API, Memory Cache (LRU), Reverse Index Service, Document Service, LB, DNS.
- path (73-90): parse query; hit -> move entry to LRU front, return; miss -> reverse index + document service, write cache at LRU front.
- implementation (94-197): hash map (query -> node) + doubly-linked list (head = newest, tail = evict); at MAX_SIZE remove tail before insert.
- invalidation (201-209): page contents change, page removed/added, page rank changes; simplest = TTL; pattern = cache-aside.
- scaling (238-242): three options for cache cluster: (a) each machine own cache, simple, low hit rate; (b) each machine full copy, simple, memory inefficient; (c) shard across machines with machine = hash(query), more complex, best; use consistent hashing.

### 5.7 Amazon sales rank by category (S/sales_rank)
- use cases (17-19): service computes past week's most popular products per category; user views them; HA. Out of scope: general e-commerce site.
- constraints (30-40): uneven traffic; items in multiple categories; items cannot change category; no subcategories; update hourly (popular items maybe more often); 10M products; 1,000 categories; 1B transactions/month; 100B reads/month; 100:1 read:write.
- math (46-60): created_at 5 B, product_id 8 B, category_id 4 B, seller_id 8 B, buyer_id 8 B, quantity 4 B, total_price 5 B -> ~40 B; 40 GB/month; 1.44 TB in 3 years; 400 tx/s; 40,000 reads/s.
- components: Sales API, Object Store (S3, raw logs instead of self-managed DFS), Sales Rank Service (MapReduce), SQL DB `sales_rank` table, Read API, Web Server (reverse proxy), Memory Cache, Analytics DB (Redshift/BigQuery), CDN, LB, DNS, read replicas.
- MapReduce (100-185): step 1 map lines within past week to ((category, product), qty), reduce sum; step 2 remap to ((category, qty), product) and let shuffle/sort do distributed sort; identity reduce; insert into `sales_rank`.
- schema (189-199): id PK, category_id FK, total_sold, product_id FK; index id, category_id, product_id.
- scaling (267-282): analytics DB in warehouse; limited time window in SQL, rest in warehouse or object store; memory cache for popular content and ranks; read replicas may not handle misses at 40K reads/s; 400 writes/s may be tough for single write master-slave -> federation, sharding, denormalization, SQL tuning, NoSQL.

### 5.8 Scaling on AWS to millions of users (S/scaling_aws)
- method (15): iterate 1) benchmark/load test, 2) profile for bottlenecks, 3) address bottleneck while evaluating alternatives and trade-offs, 4) repeat. Principles apply outside AWS (17).
- use cases (21-25): user makes read or write request; service processes, stores, returns; evolve from few users to millions; HA.
- constraints (31-43): uneven traffic; relational data needed; scale 1 -> tens of millions users (stages Users+, Users++, ...); 10M users; 1B writes/month; 100B reads/month; 100:1 read:write; 1 KB per write.
- math (49-54): 1 TB new content/month; 36 TB in 3 years; 400 writes/s; 40,000 reads/s.

Iterative evolution (stage -> trigger/bottleneck -> components added -> trade-offs):

Stage 0: Single box (S/scaling_aws:75-134)
- Trigger: 1-2 users; need basic setup only.
- Added: web server on EC2; MySQL on same box; Elastic IP (public static IP stable across reboot, enables failover by repointing); DNS (Route 53) mapping domain to IP; security: open only 80 (HTTP), 443 (HTTPS), 22 (SSH from whitelisted IPs), block outbound connections from web server.
- Scaling mode: vertical (bigger box); monitor CPU, memory, IO, network with CloudWatch, top, nagios, statsd, graphite.
- Trade-offs: vertical gets very expensive; no redundancy/failover. Start SQL, consider NoSQL later.

Stage 1: Users+ (S/scaling_aws:140-190)
- Trigger: benchmarks/profiling show MySQL consuming more memory and CPU; user content filling disk; vertical scaling now expensive and cannot scale DB and web server independently.
- Added: Object Store (S3) for static content (user files, JS, CSS, images, videos; highly scalable, reliable, server-side encryption); MySQL moved to separate box via managed RDS (simple admin/scale, multi-AZ, encryption at rest); VPC with public subnet for web server and private subnet for everything else; encrypt in transit and at rest; whitelist ports/IPs per component.
- Trade-offs: more complexity; web server must point to object store and DB; new components need securing; AWS cost up (weigh against self-managing).

Stage 2: Users++ (S/scaling_aws:192-219)
- Trigger: single web server bottlenecks at peak hours, slow responses and some downtime; want higher availability and redundancy.
- Added: horizontal scaling; load balancer (ELB, highly available; or HAProxy in active-active/active-passive across AZs); SSL termination at LB; multiple web servers across AZs; MySQL master-slave failover across AZs; split web servers from application servers (web servers become reverse proxies; separate Read API and Write API app servers, scaled independently); CDN (CloudFront) for static and some dynamic content.
- Note: profiling may show only one or two of these are needed.

Stage 3: Users+++ (S/scaling_aws:221-257)
- Trigger: read-heavy (100:1) and DB performance poor under high read volume.
- Added: Memory Cache (ElastiCache) for frequently accessed MySQL content (first try tuning MySQL's own cache) and for web server session data (makes web servers stateless, enabling autoscaling); MySQL read replicas with LBs in front; web server logic to split reads and writes; more web and app servers.
- Rationale: 1 MB from memory ~250 us vs SSD 4x vs disk 80x (see 4.1 note).

Stage 4: Users++++ (S/scaling_aws:259-296)
- Trigger: traffic spikes during US business hours and drops after; want to cut cost by matching capacity to load; small team wants DevOps automated.
- Added: Autoscaling (AWS Autoscaling): one group per web server type and per app server type, each across multiple AZs; min/max instance counts; CloudWatch triggers on time of day (predictable load) or metrics over a period (CPU, latency, network traffic, custom); DevOps automation (Chef, Puppet, Ansible); monitoring: host level (single EC2), aggregate level (LB stats), log analysis (CloudWatch, CloudTrail, Loggly, Splunk, Sumo), external site performance (Pingdom, New Relic), incidents (PagerDuty), error reporting (Sentry).
- Trade-offs: autoscaling adds complexity; scale-up and scale-down lag behind demand changes.

Stage 5: Users+++++ (S/scaling_aws:298-339)
- Trigger: growth toward stated constraints (10M users, 400 writes/s avg, 40K reads/s avg); repeated benchmarking reveals new bottlenecks.
- DB size: keep only a limited time window in MySQL, rest in data warehouse (Redshift handles 1 TB/month).
- Reads: scale memory cache for popular content and spikes; read replicas may not absorb cache misses -> more SQL scaling.
- Writes: 400 writes/s avg (higher peaks) tough for single SQL write master-slave.
- Added: SQL scaling patterns (federation, sharding, denormalization, SQL tuning); NoSQL (DynamoDB) for appropriate data; further split app servers for independent scaling; async queues and workers for non-realtime work. Example: photo upload -> app server enqueues job on SQS -> worker on EC2 or Lambda creates thumbnail, updates DB, stores thumbnail in object store.

Ongoing (400-403): keep benchmarking and monitoring; scaling is iterative.

Stage summary table:

| Stage | Bottleneck trigger | Component added |
|---|---|---|
| 0 Single box | none, 1-2 users | EC2 web + MySQL, Elastic IP, Route 53, port lockdown, vertical scaling, monitoring |
| 1 Users+ | MySQL CPU/memory, disk full, cannot scale tiers independently | S3 object store, RDS on separate box, VPC public/private subnets, encryption |
| 2 Users++ | web server overload at peak, downtime, need HA | ELB/HAProxy, SSL at LB, multi-AZ web servers, MySQL master-slave failover, web/app tier split (read/write APIs), CloudFront CDN |
| 3 Users+++ | DB slow under 100:1 reads | ElastiCache for hot data and sessions (stateless web), MySQL read replicas + LBs, read/write split |
| 4 Users++++ | diurnal spikes, cost, ops toil | Autoscaling groups per tier across AZs, CloudWatch triggers, Chef/Puppet/Ansible, monitoring stack |
| 5 Users+++++ | DB size, cache misses at 40K reads/s, 400 writes/s on single master | Redshift warehouse, bigger cache, federation/sharding/denormalization/SQL tuning, DynamoDB, SQS + workers (EC2/Lambda), further service split |

### 5.9 Common pattern across solutions
- Step 4 in every solution: do not jump to final design; iterate; justify each of LB, CDN, master-slave replicas with trade-offs (e.g. S/pastebin:240-244).
- Recurring final architecture: DNS -> CDN -> LB -> web servers (reverse proxy) -> read/write/search API servers -> services -> memory cache -> SQL write master-slave + read replicas -> object store -> analytics warehouse; queues + workers for async; REST externally, RPC internally.
- Recurring escalation when single write master-slave cannot keep up: federation, sharding, denormalization, SQL tuning, then NoSQL.

### 5.10 Object-oriented design (O/*, skimmed)
- call_center (122 lines): Rank enum; abstract Employee with take_call/complete_call/escalate_call; Operator -> Supervisor -> Director escalation chain; CallState enum; Call, CallCenter dispatch.
- deck_of_cards (117 lines): Suit enum; abstract Card; BlackJackCard (ace, face card value rules); Hand, BlackJackHand (possible_scores); Deck.
- hash_table (38 lines): Item, HashTable with _hash_function, set/get/remove (chaining).
- lru_cache (66 lines): Node, LinkedList (move_to_front, append_to_front, remove_from_tail), Cache (get/set with MAX_SIZE), same design as S/query_cache.
- online_chat (104 lines): UserService (add/remove user, friend requests approve/reject), User (message_user, message_group, friend requests), plus chat/conversation classes.
- parking_lot (125 lines): VehicleSize enum; abstract Vehicle (can_fit_in_spot, take_spot, clear_spots); Motorcycle, Car, Bus; ParkingLot with levels and spots.

## 6. Trade-off list

- Performance vs scalability: fix performance when slow for a single user; fix scalability when fast for one user but slow under load.
- Latency vs throughput: maximize throughput when latency stays acceptable; prioritize latency when per-request responsiveness is the requirement.
- CP vs AP: choose CP when business needs atomic reads and writes; choose AP when eventual consistency is acceptable or the system must keep responding during partitions.
- Strong vs eventual consistency: choose strong when transactions are required (RDBMS, file systems); choose eventual when high availability matters more (DNS, email).
- Eventual vs weak consistency: choose eventual when data must converge; choose weak when late data is useless (VoIP, video chat, realtime games).
- Active-passive vs active-active failover: choose active-passive when simplicity matters and standby capacity can idle (downtime depends on hot vs cold standby); choose active-active when both nodes should carry load and DNS or app logic can track both.
- Vertical vs horizontal scaling: choose vertical when users are few and simplicity wins; choose horizontal when cost, redundancy, and failover matter and servers can be stateless.
- Push vs pull CDN: choose push when traffic is small or content changes rarely; choose pull when traffic is heavy and only recently requested content should stay cached.
- L4 vs L7 load balancing: choose L4 when you want lowest cost per request and routing by IP/port suffices; choose L7 when routing depends on headers, cookies, or content (e.g. billing vs video hosts).
- Load balancer vs reverse proxy: choose LB when multiple servers serve the same function; choose reverse proxy when even one server benefits from SSL termination, caching, compression, static serving, and hidden backends.
- Monolith vs microservices: choose monolith when team and ops capacity are small; choose microservices when independent deployment and scaling of small services by small teams is needed and you accept deployment/ops complexity.
- Master-slave vs master-master: choose master-slave when the workload is read-heavy and read-only mode during master failover is tolerable; choose master-master when writes must survive a master failure and you accept loose consistency or higher write latency plus conflict resolution.
- Read replicas vs memory cache: choose cache first for hot, skewed reads (try DB cache tuning before that); add read replicas to absorb cache misses until replication lag or write replay bogs them down.
- Federation vs sharding: choose federation when data splits cleanly by function (users, forums, products) and no single table is huge; choose sharding when one table/entity outgrows a single DB and you can pick a partition key (user, geography).
- Hash/range sharding vs consistent hashing: choose simple key-based sharding when shard count is fixed; choose consistent hashing when shards will be added or removed and rebalancing cost must be minimized.
- Normalized vs denormalized: choose normalized when write volume is high or consistency of copies is critical; choose denormalized when reads dominate (100:1 to 1000:1) and joins are expensive or cross-shard.
- SQL vs NoSQL: choose SQL when data is structured and relational, needs joins and transactions, and benefits from mature tooling; choose NoSQL when schema is flexible, data is TB-PB scale, IOPS is very high, or data is clickstream, leaderboard, cart, hot, or lookup data.
- Key-value vs document store: choose KV when the model is simple, access is by key, and you need O(1) speed (cache layer); choose document when you need to query by fields inside the stored object and fields vary.
- Document vs wide column store: choose document for flexible, occasionally changing objects; choose wide column for very large data sets needing high availability, scalability, and key-range scans.
- Graph DB vs sharded KV + BFS: choose graph DB when relationships are many-to-many and tooling is acceptable; choose sharded KV + app-level BFS when graph DBs are excluded or tooling maturity is a concern.
- Query-level vs object-level caching: choose query-level when queries are simple and invalidation is easy; choose object-level when underlying data changes often and you want precise invalidation and async object assembly.
- Cache-aside vs write-through: choose cache-aside when you want to cache only requested data and tolerate miss latency (3 trips) and some staleness; choose write-through when reads of freshly written data must be fast and non-stale and slower writes are acceptable.
- Write-through vs write-behind: choose write-through when durability on every write matters; choose write-behind when write performance matters and you accept data loss risk if the cache fails before flushing.
- Refresh-ahead vs TTL-only: choose refresh-ahead when access patterns are predictable enough to pre-refresh hot keys; choose TTL-only when predictions would be inaccurate.
- Cache topology (own cache vs replicated vs sharded): choose per-machine cache for simplicity with low hit rate; choose full copy per machine for simplicity when memory is cheap; choose sharded with consistent hashing for best hit rate and memory use at higher complexity.
- Sync vs async (queue): choose sync for inexpensive calculations and realtime workflows; choose async queues for slow operations (extraction, fanout, thumbnails, notifications) where the user need not block.
- Redis vs RabbitMQ vs SQS as broker: choose Redis when simplicity matters and message loss is tolerable; choose RabbitMQ when you accept AMQP and self-managed nodes; choose SQS when you want hosted and can tolerate higher latency and duplicate delivery.
- Unbounded queue vs back pressure: choose back pressure (bounded queue, HTTP 503, client exponential backoff) when queue growth would exceed memory and degrade throughput.
- TCP vs UDP: choose TCP when all data must arrive intact and in order (web, DB, SMTP, FTP, SSH); choose UDP when lowest latency matters, late data is worse than lost data, or you do your own error correction (VoIP, video, games, broadcast/DHCP).
- RPC vs REST: choose RPC for internal calls where performance and control matter and tight coupling is acceptable; choose REST for public APIs needing loose coupling, statelessness, cacheability, and horizontal scaling.
- Fanout-on-write vs fanout-on-read (Twitter): choose fanout-on-write into cached home timelines for typical users to make reads O(1); choose read-time merge via search for highly-followed users whose fanout would take minutes.
- SQL hash table vs NoSQL KV (Pastebin): choose SQL when you want uniqueness via primary key index and relational tooling; choose KV store when the access pattern is purely key lookup at scale.
- File server vs object store: choose object store (S3) when you want managed, scalable, reliable blob storage with server-side encryption; choose own file server only when you must control it [inf].
- OLTP SQL vs data warehouse: keep recent/hot rows in SQL; move historical data and aggregates (analytics, monthly_spending) to Redshift/BigQuery when tables grow large or analytics load hurts OLTP.
- SQL aggregation vs MapReduce over logs: choose SQL when aggregate tables are small relative to raw rows; choose MapReduce over object-store logs when you need to offload the DB or process billions of rows (analytics, sales rank, spending).
- Elastic IP + DNS vs LB endpoint: use Elastic IP + Route 53 for a single box (repoint IP on failover); switch to LB endpoint once there are multiple web servers.
- Manual capacity vs autoscaling: choose manual when load is flat; choose autoscaling when load has predictable or metric-driven spikes and cost matters, accepting scaling lag and complexity.
