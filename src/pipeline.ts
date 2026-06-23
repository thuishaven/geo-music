import { config } from "./config.js";
import { geocode, reverseToPlace } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import type { ResolvedPlace } from "./geo/types.js";
import { findArtistsByPlace } from "./origin/musicbrainz.js";
import { resolveSegments, type Segment } from "./segments.js";
import type { MusicProvider, ProviderArtist, ProviderTrack } from "./providers/types.js";

/** Rough average song length, used to estimate how many artists fill a slice. */
const AVG_SONG_MS = 210_000;

export interface PipelineResult {
  playlistId: string;
  url: string;
  trackCount: number;
  segmentCount: number;
  targetMinutes: number;
  actualMinutes: number;
}

function minutes(ms: number): number {
  return Math.round(ms / 60000);
}

/** A candidate track tagged with the geographic level it was sourced from. */
interface TaggedTrack {
  track: ProviderTrack;
  level: string;
}

/**
 * Gather candidate artists for a segment, widening through its levels only
 * while the pool is too small to fill `budgetMs`, then rank the whole pool by
 * provider popularity (so famous local acts beat name-match orchestras).
 */
async function rankedCandidates(
  provider: MusicProvider,
  segment: Segment,
  budgetMs: number,
  seen: Set<string>,
): Promise<Array<{ artist: ProviderArtist; level: string }>> {
  const pool: Array<{ artist: ProviderArtist; level: string }> = [];
  for (const level of segment.levels) {
    const artists =
      level.mbArtists ?? (await findArtistsByPlace(level.query, config.artistCandidatesPerPlace));
    for (const a of artists) {
      const match = await provider.searchArtist(a.name);
      if (!match || seen.has(match.id)) continue;
      seen.add(match.id);
      pool.push({ artist: match, level: level.label });
    }
    // Stop widening once we likely have enough candidates to fill the slice.
    if (pool.length * config.maxTracksPerArtist * AVG_SONG_MS >= budgetMs) break;
  }

  pool.sort((a, b) => b.artist.popularity - a.artist.popularity);
  return pool;
}

/** Build the tracklist for one segment: fill its time slice from ranked artists. */
async function tracksForSegment(
  provider: MusicProvider,
  segment: Segment,
  budgetMs: number,
  seen: Set<string>,
): Promise<TaggedTrack[]> {
  const candidates = await rankedCandidates(provider, segment, budgetMs, seen);

  // Fetch top tracks for the most popular artists until the budget is covered.
  const perArtist: Array<{ tracks: ProviderTrack[]; level: string }> = [];
  let estMs = 0;
  for (const c of candidates) {
    if (estMs >= budgetMs) break;
    const tracks = await provider.getTopTracks(c.artist.id, config.maxTracksPerArtist);
    if (!tracks.length) continue;
    perArtist.push({ tracks, level: c.level });
    estMs += tracks.reduce((s, t) => s + t.durationMs, 0);
  }

  // Interleave breadth-first (every artist's #1 before anyone's #2) for variety;
  // artists are already in popularity order.
  const tagged: TaggedTrack[] = [];
  const depth = Math.max(0, ...perArtist.map((p) => p.tracks.length));
  for (let i = 0; i < depth; i++) {
    for (const p of perArtist) {
      if (p.tracks[i]) tagged.push({ track: p.tracks[i], level: p.level });
    }
  }

  // Fill the slice exactly (always take at least one track if available).
  const picked: TaggedTrack[] = [];
  let placeMs = 0;
  for (const t of tagged) {
    if (placeMs >= budgetMs && picked.length > 0) break;
    picked.push(t);
    placeMs += t.track.durationMs;
  }
  return picked;
}

/**
 * Build a route-ordered playlist from `from` to `to`, sized to the drive time.
 * Places are merged into segments (so a region spanning several villages is one
 * continuous block), each segment gets a time slice proportional to how much of
 * the route it covers, filled with its most popular local artists.
 */
export async function buildPlaylist(
  provider: MusicProvider,
  from: string,
  to: string,
): Promise<PipelineResult> {
  console.log(`\nRouting ${from} → ${to} ...`);
  const start = await geocode(from);
  const end = await geocode(to);
  const route = await getRoute(start.coord, end.coord);

  const targetMs = route.durationSec * 1000 * config.routeDurationScale;
  console.log(
    `  ${Math.round(route.distanceKm)} km, ~${minutes(route.durationSec * 1000)} min drive` +
      ` → target playlist ~${minutes(targetMs)} min`,
  );

  // Reverse-geocode waypoints to places in travel order, de-duplicating
  // consecutive repeats and capping the total to keep the run short.
  const waypoints = sampleWaypoints(route.points, config.waypointIntervalKm);
  const places: ResolvedPlace[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const place = await reverseToPlace(wp);
    if (place && places[places.length - 1]?.name !== place.name) places.push(place);
  }
  if (places.length === 0) throw new Error("No places resolved along the route.");

  // Merge consecutive same-area places into segments; weight time by coverage.
  const segments = await resolveSegments(places);
  console.log(
    `  Segments in travel order: ` +
      segments.map((s) => (s.span > 1 ? `${s.label}×${s.span}` : s.label)).join(" → "),
  );
  const msPerPlace = targetMs / places.length;

  const playlist: ProviderTrack[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    const budgetMs = msPerPlace * segment.span;
    const picked = await tracksForSegment(provider, segment, budgetMs, seen);
    playlist.push(...picked.map((p) => p.track));

    if (!picked.length) {
      console.log(`  ${segment.label}: no playable tracks (skipped)`);
      continue;
    }
    const levels = [...new Set(picked.map((p) => p.level))].join("+");
    const placeMs = picked.reduce((s, p) => s + p.track.durationMs, 0);
    console.log(`  ${segment.label}: ${picked.length} track(s), ~${minutes(placeMs)} min (${levels})`);
  }

  if (playlist.length === 0) {
    throw new Error("No tracks resolved for this route — try a longer route or larger MAX_PLACES.");
  }

  const title = `geo-music: ${from} → ${to}`;
  const description = `Artists from the places along the way, in travel order, sized to the drive. Built with geo-music.`;
  const playlistId = await provider.createPlaylist(title, description);
  await provider.addTracks(playlistId, playlist.map((t) => t.uri));

  const actualMs = playlist.reduce((sum, t) => sum + t.durationMs, 0);
  return {
    playlistId,
    url: provider.playlistUrl(playlistId),
    trackCount: playlist.length,
    segmentCount: segments.length,
    targetMinutes: minutes(targetMs),
    actualMinutes: minutes(actualMs),
  };
}
