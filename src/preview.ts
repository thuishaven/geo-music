import { config } from "./config.js";
import { geocode, reverseToPlaceName } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import { findArtistsByPlace } from "./origin/musicbrainz.js";

/**
 * Dry-run preview: runs the provider-agnostic half of the pipeline (route →
 * places → local artists) and prints what the playlist would be built from.
 * Needs no Spotify credentials, so it's the cheapest way to sanity-check the
 * geographic + artist-origin output before wiring up a music service.
 *
 * It does NOT resolve tracks or real durations (that needs a provider), so the
 * per-place time budget is shown, but the exact tracklist is not.
 */
export async function previewRoute(from: string, to: string): Promise<void> {
  console.log(`\nDRY RUN — ${from} → ${to}\n`);

  const start = await geocode(from);
  const end = await geocode(to);
  const route = await getRoute(start.coord, end.coord);

  const targetMin = Math.round((route.durationSec * config.routeDurationScale) / 60);
  console.log(
    `Route: ${Math.round(route.distanceKm)} km, ~${Math.round(route.durationSec / 60)} min drive` +
      ` → target playlist ~${targetMin} min\n`,
  );

  const waypoints = sampleWaypoints(route.points, config.waypointIntervalKm);
  const places: string[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const name = await reverseToPlaceName(wp);
    if (name && places[places.length - 1] !== name) places.push(name);
  }
  if (places.length === 0) {
    console.log("No places resolved along the route.");
    return;
  }

  const perPlaceMin = Math.round(targetMin / places.length);
  console.log(`Places in travel order (${places.length}, ~${perPlaceMin} min each):\n`);

  for (const place of places) {
    const artists = await findArtistsByPlace(place, config.artistCandidatesPerPlace);
    const names = artists.map((a) => `${a.name} (${a.score})`).join(", ");
    console.log(`  ${place}\n    ${names || "— no artists found"}\n`);
  }

  console.log(
    "Note: track selection and real durations need a music provider; this preview\n" +
      "shows artist candidates per place and the time budget only.\n",
  );
}
