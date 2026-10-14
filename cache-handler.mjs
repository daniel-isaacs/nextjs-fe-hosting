// Optimizely DXP shared Redis cache handler.
//
// Based on Optimizely's reference implementation in
// docs/isr-documentation.md §2.2. Diverges in serialization (Buffer/Map
// round-tripping) and tag invalidation (timestamps instead of deriving keys
// from path tags) — both needed for Next 16.3. Keep the Redis connection code
// aligned with the docs so upstream fixes stay easy to merge.

import { createCluster } from "redis";
import { EntraIdCredentialsProviderFactory, REDIS_SCOPE_DEFAULT } from "@redis/entraid";
import { ManagedIdentityCredential } from "@azure/identity";
import { metrics } from "@opentelemetry/api";

// Cache key prefix — namespaced per deployment slot to prevent collisions
const deploymentId = process.env.OPTIMIZELY_DXP_DEPLOYMENT_ID ?? "default";
const CACHE_PREFIX = `nextjs:${deploymentId}:`;

let cluster = null;
let connectionFailedUntil = 0;

// In-memory fallback when Redis is unavailable (local dev, connection failure)
const memoryCache = new Map();

// Telemetry (see docs/observability.md). The meter is fetched on first use, not
// at module load: this module can load before instrumentation.ts registers the
// meter provider, and the metrics API doesn't hand out a proxy that would
// switch over later. Without a provider (telemetry off) these are no-ops.
//
// - cache.lookups: every get(), by entry kind, store (redis, memory) and
//   result (hit, miss, revalidated = found but invalidated by a tag).
// - cache.redis.duration: Redis round-trip time in ms, by operation.
// - cache.redis.fallbacks: times the in-memory cache stood in for Redis, by
//   reason (unavailable, operation_failed).
//
// Recording a metric reads Date.now(), which Next.js rejects inside a page
// prerender. The handler is safe: Next.js calls it outside that scope, and
// getClient() has always read Date.now() on every call.
let instruments = null;
function telemetry() {
  if (!instruments) {
    const meter = metrics.getMeter("cache-handler");
    instruments = {
      lookups: meter.createCounter("cache.lookups", { description: "Cache handler get() calls" }),
      redisDuration: meter.createHistogram("cache.redis.duration", {
        description: "Redis round-trip time per cache operation",
        unit: "ms",
      }),
      fallbacks: meter.createCounter("cache.redis.fallbacks", {
        description: "Cache operations served by the in-memory fallback instead of Redis",
      }),
    };
  }
  return instruments;
}

async function getClient() {
  if (Date.now() < connectionFailedUntil) return null;
  if (cluster?.isOpen) return cluster;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  try {
    const result = await Promise.race([
      connectToRedis(redisUrl),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis connection timeout (10s)")), 10000)
      ),
    ]);
    return result;
  } catch (err) {
    console.warn("[cache] Redis unavailable, falling back to in-memory cache:", err?.message);
    connectionFailedUntil = Date.now() + 60_000;
    cluster = null;
    return null;
  }
}

async function connectToRedis(redisUrl) {
  let host = redisUrl.replace(/^rediss?:\/\//, "");
  let port = 10000;
  if (host.includes(":")) {
    const parts = host.split(":");
    host = parts[0];
    port = parseInt(parts[1], 10);
  }

  if (!process.env.AZURE_CLIENT_ID) {
    throw new Error("Not running in Azure (no AZURE_CLIENT_ID) — Redis auth unavailable");
  }
  const clientId = process.env.AZURE_CLIENT_ID;
  const credentialsProvider = EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
    credential: new ManagedIdentityCredential({ clientId }),
    scopes: REDIS_SCOPE_DEFAULT,
    tokenManagerConfig: {
      expirationRefreshRatio: 0.8,
    },
  });

  const net = await import("node:net");
  cluster = createCluster({
    rootNodes: [{ url: `rediss://${host}:${port}` }],
    defaults: {
      credentialsProvider,
      socket: {
        connectTimeout: 5000,
        tls: true,
      },
    },
    nodeAddressMap: (address) => {
      const [hostOrIp, nodePort] = address.split(":");
      return {
        host: net.isIP(hostOrIp) !== 0 ? host : hostOrIp,
        port: Number(nodePort),
      };
    },
  });

  cluster.on("connect", () => {
    console.log("[cache] Redis cluster connected");
  });
  cluster.on("disconnect", () => {
    console.warn("[cache] Redis cluster disconnected");
  });
  cluster.on("error", (err) => {
    console.error("[cache] Redis cluster error:", err.message);
  });
  cluster.on("node-ready", (node) => {
    console.log(`[cache] Redis node ready (${node.host}:${node.port})`);
  });
  cluster.on("node-error", (err, node) => {
    console.error(`[cache] Redis node error (${node.host}:${node.port}):`, err.message);
  });
  cluster.on("node-reconnecting", (node) => {
    console.log(`[cache] Redis node reconnecting (${node.host}:${node.port})`);
  });

  await cluster.connect();
  return cluster;
}

// Next.js caches some route kinds (APP_ROUTE — robots.txt, sitemap.xml,
// llms.txt, the image optimizer, etc.) with a Node `Buffer` body, while HTML
// pages use a string body. Plain `JSON.stringify`/`JSON.parse` turns a Buffer
// into `{type:"Buffer",data:[...]}` and never restores it, so Next serves the
// plain object as the response body — which coerces to the literal string
// `[object Object]`. These reviver/replacer helpers round-trip Buffers (and any
// nested ones) so Buffer-bodied routes survive the Redis cache intact.
//
// APP_PAGE entries also carry `segmentData: Map<string, Buffer>` (the
// per-segment client prefetch payloads). `JSON.stringify` turns a Map into
// `{}`, so every segment prefetch (`?_rsc=` with `next-router-segment-prefetch`)
// of a cached page 500s. Maps are round-tripped as entry arrays.
function serializeEntry(entry) {
  return JSON.stringify(entry, (_key, val) => {
    if (val instanceof Map) {
      return { __nextCacheMap: Array.from(val.entries()) };
    }
    // A JSON replacer runs *after* the value's own `toJSON()`, so a real Buffer
    // arrives here already shaped as `{type:"Buffer",data:[...]}`. Match that
    // shape (not `instanceof Buffer`) to capture the original bytes.
    if (val && val.type === "Buffer" && Array.isArray(val.data)) {
      return { __nextCacheBuffer: Buffer.from(val.data).toString("base64") };
    }
    return val;
  });
}

function deserializeEntry(raw) {
  return JSON.parse(raw, (_key, val) => {
    if (val && typeof val === "object" && typeof val.__nextCacheBuffer === "string") {
      return Buffer.from(val.__nextCacheBuffer, "base64");
    }
    if (val && typeof val === "object" && Array.isArray(val.__nextCacheMap)) {
      return new Map(val.__nextCacheMap);
    }
    return val;
  });
}

async function withFallback(name, operation) {
  const redis = await getClient();
  if (!redis) {
    // Local dev has no Redis at all; only count a real outage.
    if (process.env.REDIS_URL) telemetry().fallbacks.add(1, { operation: name, reason: "unavailable" });
    return null;
  }
  const started = performance.now();
  try {
    return await operation(redis);
  } catch (err) {
    console.error("[cache] Redis operation failed, using in-memory fallback:", err.message);
    telemetry().fallbacks.add(1, { operation: name, reason: "operation_failed" });
    return null;
  } finally {
    telemetry().redisDuration.record(performance.now() - started, { operation: name });
  }
}

export async function getCluster() {
  await getClient();
  return cluster;
}

// Tag invalidation is timestamp-based: revalidateTag() records when each tag
// was revalidated, and get() treats an entry as a miss if any of its tags was
// revalidated after the entry was written.
//
// The reference implementation instead mapped `_N_T_<path>` tags back to a
// storage key and deleted it. That broke in Next 16.3, which scopes route
// storage keys by source route (`/route-cache/APP_PAGE/<sha256>/$/en`), so the
// derived `/en` key never matched and published pages stayed stale forever.
// Timestamps don't depend on the key format at all.
//
// All tag timestamps live in one hash, so a lookup is a single HMGET (one slot,
// safe in cluster mode).
const TAGS_KEY = `${CACHE_PREFIX}__tags__`;
const memoryTagTimes = new Map();

// Page and route entries carry their tags (implicit `_N_T_` path/layout tags
// plus any cacheTag() values) in the `x-next-cache-tags` header, not in the
// set() context, so read both.
function entryTags(entry, ctx) {
  const tags = new Set([...(entry.tags ?? []), ...(ctx?.tags ?? []), ...(ctx?.softTags ?? [])]);
  const header = entry.value?.headers?.["x-next-cache-tags"];
  if (typeof header === "string") {
    for (const tag of header.split(",")) if (tag) tags.add(tag);
  }
  return [...tags];
}

function isRevalidated(tagTimes, lastModified) {
  return tagTimes.some((t) => t != null && Number(t) > lastModified);
}

export default class CacheHandler {
  async get(key, ctx) {
    const fromRedis = await withFallback("get", async (redis) => {
      const raw = await redis.get(`${CACHE_PREFIX}${key}`);
      if (!raw) return { entry: null, result: "miss" };
      const entry = deserializeEntry(raw);
      const tags = entryTags(entry, ctx);
      if (tags.length > 0 && isRevalidated(await redis.hmGet(TAGS_KEY, tags), entry.lastModified)) {
        return { entry: null, result: "revalidated" };
      }
      return { entry, result: "hit" };
    });

    let entry;
    let result;
    if (fromRedis) {
      ({ entry, result } = fromRedis);
    } else {
      entry = memoryCache.get(key) ?? null;
      result = entry ? "hit" : "miss";
      const tags = entry ? entryTags(entry, ctx) : [];
      if (entry && isRevalidated(tags.map((t) => memoryTagTimes.get(t)), entry.lastModified)) {
        memoryCache.delete(key);
        entry = null;
        result = "revalidated";
      }
    }
    telemetry().lookups.add(1, {
      kind: ctx?.kind ?? entry?.value?.kind ?? "unknown",
      store: fromRedis ? "redis" : "memory",
      result,
    });
    return entry ? { value: entry.value, lastModified: entry.lastModified } : null;
  }

  async set(key, value, context) {
    const tags = context?.tags ?? [];
    const entry = { value, lastModified: Date.now(), tags };
    const stored = await withFallback("set", async (redis) => {
      const serialized = serializeEntry(entry);
      const ttl = context?.revalidate;
      if (ttl && typeof ttl === "number") {
        await redis.set(`${CACHE_PREFIX}${key}`, serialized, { EX: ttl });
      } else {
        await redis.set(`${CACHE_PREFIX}${key}`, serialized);
      }
      return true;
    });
    if (!stored) {
      memoryCache.set(key, entry);
    }
  }

  async revalidateTag(tags) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    if (tagList.length === 0) return;
    const now = Date.now();
    // Always record locally too, so this instance is consistent even if the
    // Redis write fails.
    for (const tag of tagList) memoryTagTimes.set(tag, now);
    await withFallback("revalidateTag", async (redis) => {
      await redis.hSet(TAGS_KEY, Object.fromEntries(tagList.map((t) => [t, String(now)])));
      return true;
    });
  }

  resetRequestCache() {
    // no-op for shared Redis cache
  }
}
