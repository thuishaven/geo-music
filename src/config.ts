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
    // Not required for --dry-run; validated in SpotifyProvider.authenticate().
    clientId: process.env.SPOTIFY_CLIENT_ID ?? "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
    redirectUri: env("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback"),
    market: env("SPOTIFY_MARKET", "NL"),
  },
  waypointIntervalKm: num("WAYPOINT_INTERVAL_KM", 50),
  maxPlaces: num("MAX_PLACES", 12),
  // Playlist sizing: aim for a total play time near the drive time × this scale.
  routeDurationScale: num("ROUTE_DURATION_SCALE", 1.0),
  // How many MusicBrainz artists to consider per place (breadth before depth).
  artistCandidatesPerPlace: num("ARTIST_CANDIDATES_PER_PLACE", 10),
  // Cap on tracks taken from a single artist, so no one act dominates a place.
  maxTracksPerArtist: num("MAX_TRACKS_PER_ARTIST", 2),
  contact: env("CONTACT", "geo-music (https://github.com/thuishaven/geo-music)"),
};

export type Config = typeof config;
