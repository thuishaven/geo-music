import { config } from "../config.js";

/**
 * Minimum delay (ms) between requests to the same host. OSRM, Nominatim and
 * MusicBrainz all publish ~1 req/s usage policies, so we stay polite by host.
 */
const MIN_INTERVAL_MS = 1100;

/** Next free slot (epoch ms) per host. */
const nextSlotByHost = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reserve the next MIN_INTERVAL_MS-spaced slot for this host and wait for it.
 * Concurrency-safe: the slot is claimed synchronously before any await, so
 * concurrent callers are spaced out rather than firing together (keeping us
 * within MusicBrainz/Nominatim's ~1 req/s even when callers run in parallel).
 */
async function throttle(host: string): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotByHost.get(host) ?? 0);
  nextSlotByHost.set(host, slot + MIN_INTERVAL_MS);
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

const userAgent = `geo-music/0.0 ( ${config.contact} )`;

/** Rate-limited JSON GET with a polite User-Agent and a single retry on 429/5xx. */
export async function getJson<T>(url: string, accept = "application/json"): Promise<T> {
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle(host);
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: accept },
    });
    if (res.status === 429 || res.status >= 500) {
      // Back off and retry once.
      await sleep(2000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`GET ${url} failed after retry (rate-limited or server error).`);
}
