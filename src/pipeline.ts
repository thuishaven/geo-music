import { config } from "./config.js";
import { geocode, reverseToPlaceName } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import { findArtistsByPlace } from "./origin/musicbrainz.js";
import type { MusicProvider, ProviderTrack } from "./providers/types.js";

export interface PipelineResult {
  playlistId: string;
  url: string;
  trackCount: number;
  placeCount: number;
  targetMinutes: number;
  actualMinutes: number;
}

function minutes(ms: number): number {
  return Math.round(ms / 60000);
}

/**
 * Interleave per-artist track lists breadth-first: every artist's most popular
 * track first, then second-most, etc. This favours variety of artists within a
 * place over multiple tracks from the same act.
 */
function interleave(perArtist: ProviderTrack[][]): ProviderTrack[] {
  const out: ProviderTrack[] = [];
  const depth = Math.max(0, ...perArtist.map((t) => t.length));
  for (let i = 0; i < depth; i++) {
    for (const tracks of perArtist) {
      if (tracks[i]) out.push(tracks[i]);
    }
  }
  return out;
}

/**
 * Build a route-ordered playlist from `from` to `to`, sized so its total play
 * time is close to the driving time. Each place along the route gets an equal
 * slice of that time budget, filled with local artists' top tracks; the slices
 * are concatenated in travel order.
 *
 * Equal-per-place is a deliberate v1 simplification — every region gets a fair
 * share of the journey's soundtrack. Weighting slices by actual dwell time
 * (traffic, stops) or by an area's artist density is a future refinement.
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

  const waypoints = sampleWaypoints(route.points, config.waypointIntervalKm);

  // Reverse-geocode waypoints to place names in travel order, de-duplicating
  // consecutive repeats and capping the total to keep the run short.
  const places: string[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const name = await reverseToPlaceName(wp);
    if (name && places[places.length - 1] !== name) places.push(name);
  }
  if (places.length === 0) throw new Error("No places resolved along the route.");
  console.log(`  Places in travel order: ${places.join(" → ")}`);

  // Each place gets an equal slice of the time budget.
  const perPlaceMs = targetMs / places.length;

  const playlist: ProviderTrack[] = [];
  const seenArtistIds = new Set<string>();

  for (const place of places) {
    // Gather candidate tracks: several MusicBrainz artists, a few top tracks each.
    const artists = await findArtistsByPlace(place, config.artistCandidatesPerPlace);
    const perArtistTracks: ProviderTrack[][] = [];
    for (const artist of artists) {
      const match = await provider.searchArtist(artist.name);
      if (!match || seenArtistIds.has(match.id)) continue;
      seenArtistIds.add(match.id);
      const tracks = await provider.getTopTracks(match.id, config.maxTracksPerArtist);
      if (tracks.length) perArtistTracks.push(tracks);
    }
    const candidates = interleave(perArtistTracks);

    // Fill this place's time slice (always take at least one track if available).
    let placeMs = 0;
    const picked: ProviderTrack[] = [];
    for (const track of candidates) {
      if (placeMs >= perPlaceMs && picked.length > 0) break;
      picked.push(track);
      placeMs += track.durationMs;
    }
    playlist.push(...picked);

    const label = picked.length
      ? `${picked.length} track(s), ~${minutes(placeMs)} min`
      : "no playable tracks (skipped)";
    console.log(`  ${place}: ${label}`);
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
    placeCount: places.length,
    targetMinutes: minutes(targetMs),
    actualMinutes: minutes(actualMs),
  };
}
