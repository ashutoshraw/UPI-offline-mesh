'use strict';

/**
 * JVM-local Redis SETNX equivalent. In the original this was a ConcurrentHashMap
 * because multiple threads could race on putIfAbsent. Node's event loop is
 * single-threaded and synchronous code never yields mid-statement, so a plain
 * Map.has/set pair is just as atomic here as putIfAbsent was there - three
 * "simultaneous" bridge uploads in Node are really three requests handled one
 * synchronous claim() call at a time, with the same first-wins outcome.
 *
 * In production this becomes Redis: SET key NX EX 86400 (see README).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches the freshness window

let seen = new Map(); // packetHash -> claimedAt

function claim(packetHash) {
  const now = Date.now();
  if (seen.has(packetHash)) {
    return false; // duplicate
  }
  seen.set(packetHash, now);
  return true; // first claimer
}

function evictExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [hash, claimedAt] of seen.entries()) {
    if (claimedAt < cutoff) seen.delete(hash);
  }
}

function reset() {
  seen = new Map();
}

function size() {
  return seen.size;
}

// Mirrors AppConfig.java's @EnableScheduling cache eviction. Not essential for a
// demo, but kept so the cache doesn't grow unbounded if left running.
setInterval(evictExpired, 60 * 60 * 1000).unref();

module.exports = { claim, reset, size };
