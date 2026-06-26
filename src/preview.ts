import { config } from "./config.js";
import { geocode, reverseToPlace } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import type { ResolvedPlace } from "./geo/types.js";
import { findArtistsByPlace } from "./origin/musicbrainz.js";
import { resolveSegments } from "./segments.js";
import { appendDestination } from "./pipeline.js";

/**
 * Dry-run preview: runs the provider-agnostic half of the pipeline (route →
 * places → merged segments → local artists) and prints what the playlist would
 * be built from. Needs no Spotify credentials.
 *
 * It cannot rank by popularity (that needs a provider), so artists are shown in
 * MusicBrainz relevance order with their scores — useful only to confirm that
 * each segment resolves to real artists.
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

  const interval = Math.max(config.waypointIntervalKm, route.distanceKm / config.maxPlaces);
  const waypoints = sampleWaypoints(route.points, interval);
  const places: ResolvedPlace[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const place = await reverseToPlace(wp);
    if (place && places[places.length - 1]?.name !== place.name) places.push(place);
  }
  await appendDestination(places, waypoints);
  if (places.length === 0) {
    console.log("No places resolved along the route.");
    return;
  }

  const segments = await resolveSegments(places);
  console.log(
    `Segments in travel order (${segments.length} from ${places.length} places):\n`,
  );

  for (const segment of segments) {
    const minutesEach = Math.round((targetMin * segment.span) / places.length);
    const spanTag = segment.span > 1 ? ` ×${segment.span}` : "";

    // Show the first level that yields artists (mirrors the real widening).
    let line = `    — no artists at any level`;
    let levelTag = "";
    for (const level of segment.levels) {
      const artists = level.mbArtists ?? (await findArtistsByPlace(level.query, 6));
      if (artists.length) {
        line = "    " + artists.slice(0, 6).map((a) => `${a.name} (${a.score})`).join(", ");
        levelTag = level.label === "city" ? "" : `  [${level.label}]`;
        break;
      }
    }
    console.log(`  ${segment.label}${spanTag}  (~${minutesEach} min)${levelTag}\n${line}\n`);
  }

  console.log(
    "Note: a real run ranks these by Spotify popularity and fills each slice by time;\n" +
      "this preview only confirms artist availability per segment.\n",
  );
}
