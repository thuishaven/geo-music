/** A geographic point. */
export interface Coord {
  lat: number;
  lon: number;
}

/** A place encountered along the route, in travel order. */
export interface Place {
  name: string;
  coord: Coord;
}

/**
 * A reverse-geocoded place with its administrative hierarchy, used to widen
 * the artist search (city → region → country) when a place is sparse.
 */
export interface ResolvedPlace {
  name: string;
  region: string | null;
  country: string | null;
}
