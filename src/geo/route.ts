import { getJson } from "../util/http.js";
import type { Coord } from "./types.js";

const OSRM = "https://router.project-osrm.org";

interface OsrmRouteResponse {
  code: string;
  routes: Array<{
    geometry: { coordinates: [number, number][] }; // GeoJSON: [lon, lat]
    distance: number; // meters
    duration: number; // seconds
  }>;
}

export interface Route {
  /** Ordered route points as [lat, lon]. */
  points: Coord[];
  /** Estimated driving time, seconds. */
  durationSec: number;
  /** Total driving distance, kilometers. */
  distanceKm: number;
}

/**
 * Get the driving route between two coordinates. Uses the public OSRM demo
 * server (no key). Returns the geometry plus the estimated drive time, which
 * the pipeline uses to size the playlist to the length of the journey.
 */
export async function getRoute(from: Coord, to: Coord): Promise<Route> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const data = await getJson<OsrmRouteResponse>(url);
  const route = data.routes[0];
  if (data.code !== "Ok" || !route) {
    throw new Error(`OSRM could not route between the two points (code: ${data.code}).`);
  }
  return {
    points: route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    durationSec: route.duration,
    distanceKm: route.distance / 1000,
  };
}
