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
