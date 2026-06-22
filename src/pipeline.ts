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
}

/**
 * Build a route-ordered playlist from `from` to `to` using the given provider.
 * The geographic steps are provider-agnostic; only the final playlist build
 * (artist resolution → top track → create/add) goes through the provider.
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
  const waypoints = sampleWaypoints(route, config.waypointIntervalKm);
  console.log(`  ${route.length} route points → ${waypoints.length} sampled waypoints`);

  // Reverse-geocode waypoints to place names, in travel order, de-duplicating
  // consecutive repeats and capping the total to keep the run short.
  const places: string[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const name = await reverseToPlaceName(wp);
    if (name && places[places.length - 1] !== name) places.push(name);
  }
  console.log(`  Places in travel order: ${places.join(" → ")}`);

  // For each place, find local artists (MusicBrainz) and resolve a top track
  // on the provider. Order is preserved so the playlist marches along the route.
  const tracks: ProviderTrack[] = [];
  const seenArtistIds = new Set<string>();
  for (const place of places) {
    const artists = await findArtistsByPlace(place, config.artistsPerPlace);
    if (artists.length === 0) {
      console.log(`  ${place}: no artists found (skipped)`);
      continue;
    }
    const picked: string[] = [];
    for (const artist of artists) {
      const match = await provider.searchArtist(artist.name);
      if (!match || seenArtistIds.has(match.id)) continue;
      seenArtistIds.add(match.id);
      const track = await provider.getTopTrack(match.id);
      if (track) {
        tracks.push(track);
        picked.push(`${track.artistName} – ${track.name}`);
      }
    }
    console.log(`  ${place}: ${picked.length ? picked.join(", ") : "no playable tracks"}`);
  }

  if (tracks.length === 0) {
    throw new Error("No tracks resolved for this route — try a longer route or larger MAX_PLACES.");
  }

  const title = `geo-music: ${from} → ${to}`;
  const description = `Artists from the places along the way, in travel order. Built with geo-music.`;
  const playlistId = await provider.createPlaylist(title, description);
  await provider.addTracks(playlistId, tracks.map((t) => t.uri));

  return {
    playlistId,
    url: provider.playlistUrl(playlistId),
    trackCount: tracks.length,
    placeCount: places.length,
  };
}
