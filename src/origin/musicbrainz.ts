import { getJson } from "../util/http.js";

const MUSICBRAINZ = "https://musicbrainz.org/ws/2";

interface MbArtistSearchResult {
  artists: Array<{
    id: string;
    name: string;
    score: number; // 0-100 relevance
    area?: { name: string };
    "begin-area"?: { name: string };
  }>;
}

export interface OriginArtist {
  mbid: string;
  name: string;
  /** MusicBrainz relevance score (0-100) for the area query. */
  score: number;
}

/**
 * Find artists associated with a place via MusicBrainz area search.
 * Returns up to `limit` artists ordered by MusicBrainz relevance score.
 *
 * NOTE: area search is name-based and fuzzy — great for cities, noisy for
 * small towns. We filter to a minimum score to drop the worst matches.
 */
export async function findArtistsByPlace(
  place: string,
  limit: number,
  minScore = 80,
): Promise<OriginArtist[]> {
  const query = encodeURIComponent(`area:"${place}"`);
  const url = `${MUSICBRAINZ}/artist?query=${query}&fmt=json&limit=${limit * 3}`;
  const data = await getJson<MbArtistSearchResult>(url);
  return data.artists
    .filter((a) => a.score >= minScore)
    .slice(0, limit)
    .map((a) => ({ mbid: a.id, name: a.name, score: a.score }));
}

interface MbArtistRelations {
  relations?: Array<{ url?: { resource?: string } }>;
}

/**
 * Look up an artist's stored Spotify artist id via MusicBrainz URL relations,
 * for exact resolution when fuzzy name search fails. One request per call
 * (rate-limited), so callers should bound how often they use it.
 */
export async function getSpotifyArtistId(mbid: string): Promise<string | null> {
  const url = `${MUSICBRAINZ}/artist/${mbid}?inc=url-rels&fmt=json`;
  const data = await getJson<MbArtistRelations>(url);
  for (const rel of data.relations ?? []) {
    const match = (rel.url?.resource ?? "").match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/);
    if (match) return match[1];
  }
  return null;
}
