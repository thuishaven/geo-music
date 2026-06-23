import { config } from "./config.js";
import { geocode, reverseToPlace } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import type { ResolvedPlace } from "./geo/types.js";
import { findArtistsByPlace } from "./origin/musicbrainz.js";

/**
 * Dry-run preview: runs the provider-agnostic half of the pipeline (route →
 * places → local artists, with city → region → country fallback) and prints
 * what the playlist would be built from. Needs no Spotify credentials.
 *
 * It cannot rank by popularity (that needs a provider), so artists are shown in
 * MusicBrainz relevance order with their scores — useful only to confirm that
 * each place resolves to *some* real artists at *some* level.
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
  const places: ResolvedPlace[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const place = await reverseToPlace(wp);
    if (place && places[places.length - 1]?.name !== place.name) places.push(place);
  }
  if (places.length === 0) {
    console.log("No places resolved along the route.");
    return;
  }

  const perPlaceMin = Math.round(targetMin / places.length);
  console.log(`Places in travel order (${places.length}, ~${perPlaceMin} min each):\n`);

  for (const place of places) {
    const levels = [
      { label: "city", query: place.name },
      ...(place.region ? [{ label: `region: ${place.region}`, query: place.region }] : []),
      ...(place.country ? [{ label: `country: ${place.country}`, query: place.country }] : []),
    ];

    let printed = false;
    for (const level of levels) {
      const artists = await findArtistsByPlace(level.query, 6);
      if (artists.length) {
        const names = artists.map((a) => `${a.name} (${a.score})`).join(", ");
        const tag = level.label === "city" ? "" : `  [fallback → ${level.label}]`;
        console.log(`  ${place.name}${tag}\n    ${names}\n`);
        printed = true;
        break;
      }
    }
    if (!printed) console.log(`  ${place.name}\n    — no artists at any level\n`);
  }

  console.log(
    "Note: a real run ranks these by Spotify popularity and fills each slice by time;\n" +
      "this preview only confirms artist availability per place/level.\n",
  );
}
