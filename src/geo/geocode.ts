import { getJson } from "../util/http.js";
import type { Coord } from "./types.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";

interface NominatimSearchResult {
  lat: string;
  lon: string;
  display_name: string;
}

/** Forward-geocode a free-text place name to coordinates. */
export async function geocode(query: string): Promise<{ coord: Coord; displayName: string }> {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
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
 * Reverse-geocode a coordinate to the most specific populated-place name
 * (city → town → village → municipality → county). Returns null if none found.
 */
export async function reverseToPlaceName(coord: Coord): Promise<string | null> {
  // zoom=10 keeps results at roughly the city/town level.
  const url = `${NOMINATIM}/reverse?lat=${coord.lat}&lon=${coord.lon}&format=json&zoom=10&addressdetails=1`;
  const result = await getJson<NominatimReverseResult>(url);
  const a = result.address ?? {};
  return (
    a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? null
  );
}
