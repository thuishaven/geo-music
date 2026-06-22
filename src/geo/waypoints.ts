import type { Coord } from "./types.js";

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two coordinates, in kilometers. */
export function haversineKm(a: Coord, b: Coord): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Sample points along a dense route geometry roughly every `intervalKm`,
 * always keeping the first and last point. This thins thousands of route
 * coordinates down to a handful of waypoints to reverse-geocode.
 */
export function sampleWaypoints(route: Coord[], intervalKm: number): Coord[] {
  if (route.length === 0) return [];
  const samples: Coord[] = [route[0]];
  let accumulated = 0;
  for (let i = 1; i < route.length; i++) {
    accumulated += haversineKm(route[i - 1], route[i]);
    if (accumulated >= intervalKm) {
      samples.push(route[i]);
      accumulated = 0;
    }
  }
  const last = route[route.length - 1];
  if (samples[samples.length - 1] !== last) samples.push(last);
  return samples;
}
