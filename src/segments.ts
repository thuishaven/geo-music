import { config } from "./config.js";
import type { ResolvedPlace } from "./geo/types.js";
import { findArtistsByPlace, type OriginArtist } from "./origin/musicbrainz.js";

/** One geographic level to search, with its MusicBrainz result cached if known. */
export interface SearchLevel {
  /** Which administrative level this is. */
  kind: "city" | "region" | "country";
  /** Display label, e.g. "city", "region: Utrecht", "country: France". */
  label: string;
  /** Area string passed to MusicBrainz. */
  query: string;
  /** Cached MusicBrainz artists (set for the probed city level), else null. */
  mbArtists: OriginArtist[] | null;
}

/**
 * A stretch of route that searches one effective area. Consecutive waypoint
 * places that resolve to the same area (e.g. four villages all falling back to
 * the same region) are merged into a single segment whose `span` records how
 * many places it covers — used to weight its share of the playlist's time.
 */
export interface Segment {
  /** Effective key used to merge consecutive places. */
  key: string;
  /** Display name: the city, or the region/country it fell back to. */
  label: string;
  /** Representative coordinate (first place in the segment), for the map. */
  coord: import("./geo/types.js").Coord;
  /** Number of waypoint places this segment covers (its travel-time weight). */
  span: number;
  /** Levels to search, most specific first; widened only if under-filled. */
  levels: SearchLevel[];
}

/**
 * Resolve places (in travel order) to merged segments. Each place is probed at
 * city level once (cached); if the city has no artists, the place is keyed on
 * its region (or country) so consecutive sparse places in the same region merge
 * into one bigger block instead of fragmenting the route.
 */
export async function resolveSegments(places: ResolvedPlace[]): Promise<Segment[]> {
  const segments: Segment[] = [];

  for (const place of places) {
    const cityArtists = await findArtistsByPlace(place.name, config.artistCandidatesPerPlace);
    const hasCity = cityArtists.length > 0;

    let key: string;
    let label: string;
    const levels: SearchLevel[] = [];

    if (hasCity) {
      key = `city:${place.name}`;
      label = place.name;
      levels.push({ kind: "city", label: "city", query: place.name, mbArtists: cityArtists });
      if (place.region) levels.push({ kind: "region", label: `region: ${place.region}`, query: place.region, mbArtists: null });
      if (place.country) levels.push({ kind: "country", label: `country: ${place.country}`, query: place.country, mbArtists: null });
    } else {
      // No city artists: fall back, and key on the fallback area so adjacent
      // sparse places in the same region/country merge together.
      const fallback = place.region ?? place.country ?? place.name;
      key = `area:${fallback}`;
      label = fallback;
      if (place.region) levels.push({ kind: "region", label: `region: ${place.region}`, query: place.region, mbArtists: null });
      if (place.country) levels.push({ kind: "country", label: `country: ${place.country}`, query: place.country, mbArtists: null });
      if (levels.length === 0) levels.push({ kind: "city", label: "city", query: place.name, mbArtists: cityArtists });
    }

    const prev = segments[segments.length - 1];
    if (prev && prev.key === key) {
      prev.span += 1;
    } else {
      segments.push({ key, label, coord: place.coord, span: 1, levels });
    }
  }

  return segments;
}
