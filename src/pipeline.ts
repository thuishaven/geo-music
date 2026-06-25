import { config } from "./config.js";
import { geocode, reverseToPlace } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import type { ResolvedPlace } from "./geo/types.js";
import { findArtistsByPlace } from "./origin/musicbrainz.js";
import { resolveSegments, type Segment } from "./segments.js";
import type { MusicProvider, ProviderArtist, ProviderTrack } from "./providers/types.js";

/** Rough average song length, used to estimate how many artists fill a slice. */
const AVG_SONG_MS = 210_000;

export interface PipelineResult {
  playlistId: string;
  url: string;
  trackCount: number;
  segmentCount: number;
  targetMinutes: number;
  actualMinutes: number;
}

function minutes(ms: number): number {
  return Math.round(ms / 60000);
}

/** A candidate track tagged with the geographic level it was sourced from. */
interface TaggedTrack {
  track: ProviderTrack;
  level: string;
}

/** Genre substrings that mark an artist as classical/opera for the per-segment cap. */
const CLASSICAL_GENRES = [
  "classical", "baroque", "opera", "operatic", "orchestra", "choral",
  "early music", "romantic", "impressionism", "renaissance", "compositeur",
];

function isClassical(genres: string[]): boolean {
  return genres.some((g) => CLASSICAL_GENRES.some((c) => g.includes(c)));
}

/** Genre substrings marking an artist as non-music (audiobooks, kids' spoken). */
const NON_MUSIC_GENRES = [
  "hörspiel", "horspiel", "hörbuch", "horbuch", "audiobook", "spoken word",
  "children's music", "kindermusik", "kinderlieder", "kinderliedjes", "nursery", "lullaby",
];

function isNonMusicArtist(genres: string[]): boolean {
  return genres.some((g) => NON_MUSIC_GENRES.some((n) => g.includes(n)));
}

/**
 * Title patterns marking a track as non-music (audiobook/audio-drama chapters,
 * untitled "Track 01"). Kept narrow so real songs — e.g. "Oxygène, Pt. 4" or a
 * classical movement — are not caught.
 */
const NON_MUSIC_TITLE = /(\bkapitel\b|\bteil\s*\d|\bfolge\s*\d|\bchapter\s*\d|hörspiel|hörbuch|^track\s*\d+$)/i;

function isNonMusicTitle(name: string): boolean {
  return NON_MUSIC_TITLE.test(name);
}

/**
 * Classical/orchestral signals from STABLE data (artist names + track titles),
 * because Spotify's genre tags are unreliable — the same request returns
 * "classical" one moment and [] the next. Names and titles never flap.
 */
// A credited artist that is plainly a classical ensemble. "symphony orchestra"
// (not bare "orchestra") avoids false hits like Electric Light Orchestra.
const ENSEMBLE_NAME =
  /\b(symphony orchestra|radio symphony|philharmoni|sinfonie|sinfonieorchester|staatskapelle|kammerorchester|chamber orchestra|baroque orchestra|festival orchestra|orchestre|opera|opernhaus|concertgebouw|conservatoire|consort|cappella|capella|chœur)\b/i;

// Catalogue numbers (BWV, Op. …), key signatures, opera acts, movement names.
const CLASSICAL_TITLE =
  /\b(bwv|hwv|kv|woo|rv|wd|op)\.?\s*\d|\bno\.?\s*\d+\s+in\s+[a-g]\b|\bin\s+[a-g](-|\s)?(sharp|flat)?\s*(major|minor)\b|\b(act|akt)\s+[ivx]+\s*:|\b(allegro|andante|adagio|presto|largo|moderato|scherzo|menuetto|gymnop|nocturne|barcarolle|berceuse|pavane|habanera|requiem|lacrimosa|kyrie|magnificat|cantata)\b/i;

function looksClassical(track: ProviderTrack): boolean {
  return (
    CLASSICAL_TITLE.test(track.name) ||
    track.artistNames.some((n) => ENSEMBLE_NAME.test(n))
  );
}

/**
 * Normalize a track title so the same recording collapses regardless of credit
 * or version: drop "- Radio Edit"/"- Live" suffixes and "(feat. …)" parts, then
 * strip to alphanumerics. Used to de-duplicate across the whole playlist.
 */
function trackKey(name: string): string {
  return name
    .toLowerCase()
    .split(" - ")[0]
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Gather candidate artists for a segment, widening through its levels only
 * while the pool is too small to fill `budgetMs`, then rank the whole pool by
 * provider popularity (so famous local acts beat name-match orchestras).
 */
async function rankedCandidates(
  provider: MusicProvider,
  segment: Segment,
  budgetMs: number,
  seen: Set<string>,
): Promise<Array<{ artist: ProviderArtist; level: string }>> {
  const pool: Array<{ artist: ProviderArtist; level: string }> = [];
  for (const level of segment.levels) {
    const artists =
      level.mbArtists ?? (await findArtistsByPlace(level.query, config.artistCandidatesPerPlace));
    for (const a of artists) {
      const match = await provider.searchArtist(a.name);
      if (!match || seen.has(match.id)) continue;
      seen.add(match.id);
      // Drop obscure artists so ranking promotes real local acts, not noise.
      if (match.popularity < config.minArtistPopularity) continue;
      // Drop non-music acts (audiobooks, audio-dramas, children's spoken word).
      if (isNonMusicArtist(match.genres)) continue;
      pool.push({ artist: match, level: level.label });
    }
    // Stop widening once we likely have enough candidates to fill the slice.
    if (pool.length * config.maxTracksPerArtist * AVG_SONG_MS >= budgetMs) break;
  }

  pool.sort((a, b) => b.artist.popularity - a.artist.popularity);
  return pool;
}

/** Build the tracklist for one segment: fill its time slice from ranked artists. */
async function tracksForSegment(
  provider: MusicProvider,
  segment: Segment,
  budgetMs: number,
  seen: Set<string>,
  seenTracks: Set<string>,
): Promise<TaggedTrack[]> {
  const candidates = await rankedCandidates(provider, segment, budgetMs, seen);

  // Fetch top tracks for the most popular artists until the budget is covered,
  // capping classical/opera acts so country fallback doesn't drown the segment.
  const perArtist: Array<{ tracks: ProviderTrack[]; level: string }> = [];
  let estMs = 0;
  let classicalUsed = 0;
  for (const c of candidates) {
    if (estMs >= budgetMs) break;
    if (isClassical(c.artist.genres)) {
      if (classicalUsed >= config.maxClassicalPerSegment) continue;
      classicalUsed++;
    }
    const tracks = (await provider.getTopTracks(c.artist.id, config.maxTracksPerArtist)).filter(
      (t) => t.popularity >= config.minTrackPopularity,
    );
    if (!tracks.length) continue;
    perArtist.push({ tracks, level: c.level });
    estMs += tracks.reduce((s, t) => s + t.durationMs, 0);
  }

  // Interleave breadth-first (every artist's #1 before anyone's #2) for variety;
  // artists are already in popularity order.
  const tagged: TaggedTrack[] = [];
  const depth = Math.max(0, ...perArtist.map((p) => p.tracks.length));
  for (let i = 0; i < depth; i++) {
    for (const p of perArtist) {
      if (p.tracks[i]) tagged.push({ track: p.tracks[i], level: p.level });
    }
  }

  // Vet each track by STABLE signals (credited names + title) plus genres where
  // available. Genre data is flaky, so names/titles are the primary defence.
  const creditIds = [...new Set(tagged.flatMap((t) => t.track.artistIds))];
  const creditGenres = await provider.getArtistGenres(creditIds);
  const excludeClassical = config.maxClassicalPerSegment === 0;
  const hasBadCredit = (t: ProviderTrack): boolean => {
    if (excludeClassical && looksClassical(t)) return true;
    return t.artistIds.some((id) => {
      const g = creditGenres.get(id) ?? [];
      return isNonMusicArtist(g) || (excludeClassical && isClassical(g));
    });
  };

  // Fill the slice (always take at least one track if available), skipping any
  // track whose title already appears anywhere in the playlist.
  const picked: TaggedTrack[] = [];
  let placeMs = 0;
  for (const t of tagged) {
    if (placeMs >= budgetMs && picked.length > 0) break;
    // Skip audiobook/audio-drama chapters and tracks with non-music co-credits.
    if (isNonMusicTitle(t.track.name) || hasBadCredit(t.track)) continue;
    const key = trackKey(t.track.name);
    if (seenTracks.has(key)) continue;
    seenTracks.add(key);
    picked.push(t);
    placeMs += t.track.durationMs;
  }
  return picked;
}

/**
 * Build a route-ordered playlist from `from` to `to`, sized to the drive time.
 * Places are merged into segments (so a region spanning several villages is one
 * continuous block), each segment gets a time slice proportional to how much of
 * the route it covers, filled with its most popular local artists.
 */
export async function buildPlaylist(
  provider: MusicProvider,
  from: string,
  to: string,
): Promise<PipelineResult> {
  console.log(`\nRouting ${from} → ${to} ...`);
  const start = await geocode(from);
  const end = await geocode(to);
  const route = await getRoute(start.coord, end.coord);

  const targetMs = route.durationSec * 1000 * config.routeDurationScale;
  console.log(
    `  ${Math.round(route.distanceKm)} km, ~${minutes(route.durationSec * 1000)} min drive` +
      ` → target playlist ~${minutes(targetMs)} min`,
  );

  // Reverse-geocode waypoints to places in travel order, de-duplicating
  // consecutive repeats and capping the total to keep the run short.
  const waypoints = sampleWaypoints(route.points, config.waypointIntervalKm);
  const places: ResolvedPlace[] = [];
  for (const wp of waypoints) {
    if (places.length >= config.maxPlaces) break;
    const place = await reverseToPlace(wp);
    if (place && places[places.length - 1]?.name !== place.name) places.push(place);
  }
  if (places.length === 0) throw new Error("No places resolved along the route.");

  // Merge consecutive same-area places into segments; weight time by coverage.
  const segments = await resolveSegments(places);
  console.log(
    `  Segments in travel order: ` +
      segments.map((s) => (s.span > 1 ? `${s.label}×${s.span}` : s.label)).join(" → "),
  );
  const msPerPlace = targetMs / places.length;

  const playlist: ProviderTrack[] = [];
  const seen = new Set<string>();
  const seenTracks = new Set<string>();

  for (const segment of segments) {
    const budgetMs = msPerPlace * segment.span;
    const picked = await tracksForSegment(provider, segment, budgetMs, seen, seenTracks);
    playlist.push(...picked.map((p) => p.track));

    if (!picked.length) {
      console.log(`  ${segment.label}: no playable tracks (skipped)`);
      continue;
    }
    const levels = [...new Set(picked.map((p) => p.level))].join("+");
    const placeMs = picked.reduce((s, p) => s + p.track.durationMs, 0);
    console.log(`  ${segment.label}: ${picked.length} track(s), ~${minutes(placeMs)} min (${levels})`);
  }

  if (playlist.length === 0) {
    throw new Error("No tracks resolved for this route — try a longer route or larger MAX_PLACES.");
  }

  const title = `geo-music: ${from} → ${to}`;
  const description = `Artists from the places along the way, in travel order, sized to the drive. Built with geo-music.`;
  const playlistId = await provider.createPlaylist(title, description);
  await provider.addTracks(playlistId, playlist.map((t) => t.uri));

  const actualMs = playlist.reduce((sum, t) => sum + t.durationMs, 0);
  return {
    playlistId,
    url: provider.playlistUrl(playlistId),
    trackCount: playlist.length,
    segmentCount: segments.length,
    targetMinutes: minutes(targetMs),
    actualMinutes: minutes(actualMs),
  };
}
