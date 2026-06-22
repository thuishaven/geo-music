import { getJson } from "../util/http.js";
import type { Coord } from "./types.js";

const OSRM = "https://router.project-osrm.org";

interface OsrmRouteResponse {
  code: string;
  routes: Array<{
    geometry: { coordinates: [number, number][] }; // GeoJSON: [lon, lat]
    distance: number; // meters
  }>;
}

/**
 * Get the driving route between two coordinates as an ordered list of points.
 * Uses the public OSRM demo server (no key). Coordinates are returned [lat,lon].
 */
export async function getRoute(from: Coord, to: Coord): Promise<Coord[]> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const data = await getJson<OsrmRouteResponse>(url);
  if (data.code !== "Ok" || !data.routes[0]) {
    throw new Error(`OSRM could not route between the two points (code: ${data.code}).`);
  }
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
}
