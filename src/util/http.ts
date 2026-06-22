import { config } from "../config.js";

/**
 * Minimum delay (ms) between requests to the same host. OSRM, Nominatim and
 * MusicBrainz all publish ~1 req/s usage policies, so we stay polite by host.
 */
const MIN_INTERVAL_MS = 1100;

const lastCallByHost = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until at least MIN_INTERVAL_MS has passed since the last call to this host. */
async function throttle(host: string): Promise<void> {
  const last = lastCallByHost.get(host) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastCallByHost.set(host, Date.now());
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
