import { config } from "./config.js";
import { geocode, reverseToPlace } from "./geo/geocode.js";
import { getRoute } from "./geo/route.js";
import { sampleWaypoints } from "./geo/waypoints.js";
import type { ResolvedPlace } from "./geo/types.js";
import { findArtistsByPlace, getSpotifyArtistId } from "./origin/musicbrainz.js";
import { resolveSegments, type Segment, type SearchLevel } from "./segments.js";
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
  /** Rich plan for the web UI (map + timeline). */
  plan: PlaylistPlan;
}

/** A single track placed on the journey, for the map + timeline. */
export interface PlanTrack {
  artist: string;
  title: string;
  uri: string;
  durationMs: number;
  /** Cumulative offset from the start of the playlist (≈ minutes into the drive). */
  offsetMs: number;
  /** Which segment (place) it belongs to. */
  place: string;
  /** Approximate coordinate where you'll be when it plays. */
  lat: number;
  lon: number;
}

/** Everything the web UI needs to render the journey. */
export interface PlaylistPlan {
  from: string;
  to: string;
  distanceKm: number;
  durationMin: number;
  playlistId: string;
  url: string;
  /** Down-sampled route polyline as [lat, lon] pairs for drawing. */
  route: Array<[number, number]>;
  /** Place markers in travel order. */
  places: Array<{ name: string; lat: number; lon: number }>;
  tracks: PlanTrack[];
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
 * Resolve a MusicBrainz candidate to a provider artist, in precision order:
 *   1. strict name match (correct, kills famous-stranger hijacks)
 *   2. MusicBrainz-stored Spotify link (exact, bounded by rate limit)
 *   3. guarded loose fallback — the top fuzzy result, accepted ONLY if it isn't
 *      a famous stranger (popularity ceiling), to recover recall without Drakes.
 */
async function resolveCandidate(
  provider: MusicProvider,
  mbid: string,
  name: string,
  linkBudget: { left: number },
): Promise<ProviderArtist | null> {
  const { strict, top } = await provider.searchArtist(name);
  if (strict) return strict;

  if (config.useMbLinks && linkBudget.left > 0) {
    linkBudget.left--;
    const spotifyId = await getSpotifyArtistId(mbid);
    if (spotifyId) {
      const byId = await provider.getArtistById(spotifyId);
      if (byId) return byId;
    }
  }

  if (top && top.popularity <= config.looseFallbackMaxPop) return top;
  return null;
}

/** Resolved, filtered candidates for one search level (memoized per route). */
type LevelCandidates = Array<{ artist: ProviderArtist; level: string }>;

/**
 * Resolve and filter all candidates for one geographic level, caching the
 * result by query so re-visiting a country across many segments is cheap.
 */
async function resolveLevel(
  provider: MusicProvider,
  level: SearchLevel,
  linkBudget: { left: number },
  cache: Map<string, LevelCandidates>,
): Promise<LevelCandidates> {
  const cached = cache.get(level.query);
  if (cached) return cached;

  const count = level.kind === "country" ? config.countryCandidates : config.artistCandidatesPerPlace;
  const artists = level.mbArtists ?? (await findArtistsByPlace(level.query, count));
  const out: LevelCandidates = [];
  for (const a of artists) {
    const match = await resolveCandidate(provider, a.mbid, a.name, linkBudget);
    if (!match) continue;
    if (match.popularity < config.minArtistPopularity) continue; // drop obscure
    if (isNonMusicArtist(match.genres)) continue; // drop audiobooks/spoken word
    out.push({ artist: match, level: level.label });
  }
  cache.set(level.query, out);
  return out;
}

/**
 * Gather candidates for a segment as a blend of levels: local (city/region) up
 * to roughly the slice budget, PLUS always the country level (deep pull) so
 * recognizable national acts are in the mix. Ranking by popularity then lets the
 * best-known songs lead, across all levels, while strict resolution keeps the
 * matches correct. Famous nationals dedupe across segments, so later segments in
 * the same country lean back toward regional/local.
 */
async function rankedCandidates(
  provider: MusicProvider,
  segment: Segment,
  budgetMs: number,
  seen: Set<string>,
  cache: Map<string, LevelCandidates>,
): Promise<Array<{ artist: ProviderArtist; level: string }>> {
  const linkBudget = { left: config.maxLinkLookups };
  const pool: LevelCandidates = [];

  // Local levels first, stopping once we likely have enough to fill the slice.
  for (const level of segment.levels.filter((l) => l.kind !== "country")) {
    pool.push(...(await resolveLevel(provider, level, linkBudget, cache)));
    if (pool.length * config.maxTracksPerArtist * AVG_SONG_MS >= budgetMs) break;
  }
  // Always add the country level, so national acts join the mix regardless.
  for (const level of segment.levels.filter((l) => l.kind === "country")) {
    pool.push(...(await resolveLevel(provider, level, linkBudget, cache)));
  }

  // Dedupe across segments and rank by popularity (well-known songs lead).
  const result: LevelCandidates = [];
  for (const c of pool) {
    if (seen.has(c.artist.id)) continue;
    seen.add(c.artist.id);
    result.push(c);
  }
  result.sort((a, b) => b.artist.popularity - a.artist.popularity);
  return result;
}

/** Build the tracklist for one segment: fill its time slice from ranked artists. */
async function tracksForSegment(
  provider: MusicProvider,
  segment: Segment,
  budgetMs: number,
  seen: Set<string>,
  seenTracks: Set<string>,
  cache: Map<string, LevelCandidates>,
): Promise<TaggedTrack[]> {
  const candidates = await rankedCandidates(provider, segment, budgetMs, seen, cache);

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
  const planTracks: PlanTrack[] = [];
  const placeMarkers: Array<{ name: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  const seenTracks = new Set<string>();
  const levelCache = new Map<string, LevelCandidates>();
  let offsetMs = 0;

  for (const segment of segments) {
    const budgetMs = msPerPlace * segment.span;
    const picked = await tracksForSegment(provider, segment, budgetMs, seen, seenTracks, levelCache);

    if (!picked.length) {
      console.log(`  ${segment.label}: no playable tracks (skipped)`);
      continue;
    }
    placeMarkers.push({ name: segment.label, lat: segment.coord.lat, lon: segment.coord.lon });
    for (const { track } of picked) {
      playlist.push(track);
      planTracks.push({
        artist: track.artistName,
        title: track.name,
        uri: track.uri,
        durationMs: track.durationMs,
        offsetMs,
        place: segment.label,
        lat: segment.coord.lat,
        lon: segment.coord.lon,
      });
      offsetMs += track.durationMs;
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
  const url = provider.playlistUrl(playlistId);
  const actualMs = playlist.reduce((sum, t) => sum + t.durationMs, 0);

  // Down-sample the route polyline to keep the map payload small (~200 points).
  const step = Math.max(1, Math.floor(route.points.length / 200));
  const routeLine = route.points.filter((_, i) => i % step === 0).map((p) => [p.lat, p.lon] as [number, number]);

  return {
    playlistId,
    url,
    trackCount: playlist.length,
    segmentCount: segments.length,
    targetMinutes: minutes(targetMs),
    actualMinutes: minutes(actualMs),
    plan: {
      from,
      to,
      distanceKm: Math.round(route.distanceKm),
      durationMin: minutes(route.durationSec * 1000),
      playlistId,
      url,
      route: routeLine,
      places: placeMarkers,
      tracks: planTracks,
    },
  };
}
