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
  artistCandidatesPerPlace: num("ARTIST_CANDIDATES_PER_PLACE", 25),
  // Drop artists below this Spotify popularity (0-100) to cut obscure noise
  // (bird recordings, audition-show filler, zero-play bootlegs).
  minArtistPopularity: num("MIN_ARTIST_POPULARITY", 25),
  // Drop individual tracks below this Spotify popularity, catching novelty/
  // narration top tracks from otherwise-popular artists (track pop is reliable).
  minTrackPopularity: num("MIN_TRACK_POPULARITY", 20),
  // Cap on tracks taken from a single artist, so no one act dominates a place.
  maxTracksPerArtist: num("MAX_TRACKS_PER_ARTIST", 2),
  // Cap on classical/opera artists per segment. 0 = exclude classical entirely
  // (default — it's mostly country-level tagging noise and off-vibe for a drive).
  maxClassicalPerSegment: num("MAX_CLASSICAL_PER_SEGMENT", 0),
  contact: env("CONTACT", "geo-music (https://github.com/thuishaven/geo-music)"),
};

export type Config = typeof config;
