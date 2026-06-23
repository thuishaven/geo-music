import { getJson } from "../util/http.js";
import type { Coord, ResolvedPlace } from "./types.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";

// Ask Nominatim for English names so place/region/country strings match
// MusicBrainz area names reliably across borders (e.g. "Belgium", not
// "België / Belgique").
const LANG = "&accept-language=en";

interface NominatimSearchResult {
  lat: string;
  lon: string;
  display_name: string;
}

/** Forward-geocode a free-text place name to coordinates. */
export async function geocode(query: string): Promise<{ coord: Coord; displayName: string }> {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=1${LANG}`;
  const results = await getJson<NominatimSearchResult[]>(url);
  const first = results[0];
  if (!first) throw new Error(`Could not geocode "${query}".`);
  return {
    coord: { lat: Number(first.lat), lon: Number(first.lon) },
    displayName: first.display_name,
  };
}

interface NominatimReverseResult {
  address?: Record<string, string>;
}

/**
 * Reverse-geocode a coordinate to a place with its region and country.
 * The name is the most specific populated place (city → town → village …);
 * region/country are used as fallback search levels. Returns null if no
 * populated-place name can be derived.
 */
export async function reverseToPlace(coord: Coord): Promise<ResolvedPlace | null> {
  // zoom=10 keeps the primary result at roughly the city/town level.
  const url = `${NOMINATIM}/reverse?lat=${coord.lat}&lon=${coord.lon}&format=json&zoom=10&addressdetails=1${LANG}`;
  const result = await getJson<NominatimReverseResult>(url);
  const a = result.address ?? {};
  const name =
    a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? null;
  if (!name) return null;
  const region = a.state ?? a.county ?? a.state_district ?? null;
  return {
    name,
    region: region && region !== name ? region : null,
    country: a.country ?? null,
  };
}
