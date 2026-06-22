import "dotenv/config";

/** Read an env var, throwing a helpful error if it is required and missing. */
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`Env var ${name} must be a number, got "${raw}".`);
  return parsed;
}

export const config = {
  spotify: {
    clientId: env("SPOTIFY_CLIENT_ID"),
    clientSecret: env("SPOTIFY_CLIENT_SECRET"),
    redirectUri: env("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback"),
    market: env("SPOTIFY_MARKET", "NL"),
  },
  waypointIntervalKm: num("WAYPOINT_INTERVAL_KM", 50),
  maxPlaces: num("MAX_PLACES", 12),
  artistsPerPlace: num("ARTISTS_PER_PLACE", 2),
  contact: env("CONTACT", "geo-music (https://github.com/thuishaven/geo-music)"),
};

export type Config = typeof config;
