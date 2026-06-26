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
 * Build a function mapping a fraction (0–1) of the route's length to a point
 * along it (linear interpolation between vertices). Used to place each track at
 * roughly where you'll be when it plays, so they spread along the whole route
 * instead of clustering at a few place markers.
 */
export function routeInterpolator(route: Coord[]): (fraction: number) => Coord {
  const cumulative = [0];
  for (let i = 1; i < route.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineKm(route[i - 1], route[i]));
  }
  const total = cumulative[cumulative.length - 1] || 1;
  return (fraction: number): Coord => {
    if (route.length === 0) return { lat: 0, lon: 0 };
    if (fraction <= 0) return route[0];
    if (fraction >= 1) return route[route.length - 1];
    const target = fraction * total;
    let i = 1;
    while (i < route.length && cumulative[i] < target) i++;
    const prev = cumulative[i - 1];
    const segLen = cumulative[i] - prev || 1;
    const t = (target - prev) / segLen;
    const a = route[i - 1];
    const b = route[i];
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  };
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
