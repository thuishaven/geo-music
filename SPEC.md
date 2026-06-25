# geo-music — Project Specification

> Turn a road trip into a soundtrack of place. Given a start and an end, geo-music
> builds a playlist of artists *from* the towns you drive through, ordered along the
> route — so when you roll into Amsterdam, you hear Amsterdam.

**Status**: Phase 0 prototype working (Spotify CLI) — see §7
**Org**: [thuishaven](https://github.com/thuishaven)
**License**: MIT

---

## 1. Vision and Why

### The idea

Music and place are deeply linked, and a journey is a natural sequence. geo-music
fuses the two: feed it a route from A to B and it produces a playlist where the
artists' origins march geographically along your path. The emotional hook is
*discovery in motion* — the soundtrack changes as the landscape does, and crossing
into a new region brings a new set of local voices.

This is "sonic geography": not a generic "songs for your trip" playlist, but one
where the *order and selection are driven by where artists are actually from*,
synced to the order in which you pass through their places.

### Where it fits

- **Best for**: road trips, scenic drives, tourism, long cross-country journeys.
- **Poor fit for**: daily commutes (you'd hear the same two or three places forever).

### What it is NOT (for now)

- **Not live / GPS-reactive.** v1 generates a *static* playlist before the trip,
  ordered A→B. No background location, no dynamic re-queueing while driving.
  (Live reactivity is a compelling future direction — see §8 — but explicitly out
  of scope for the first version.)
- **Not a streaming service.** It builds playlists *in* Spotify / Apple Music; it
  does not host or stream audio itself.
- **Not a verified-accuracy music encyclopedia.** Artist-origin data is best-effort
  from public sources; gaps and occasional mismatches are accepted in v1.

---

## 2. Scope of v1

A static, route-ordered playlist generator.

**In scope**
- Input: a start location and an end location (place names or coordinates).
- Output: an ordered playlist in the user's music service, artists grouped by the
  places along the route, in travel order.
- Two playlist targets behind one interface: **Spotify first**, **Apple Music second**.

**In scope (added)**
- **Playlist length ≈ drive time.** The total play time targets the route's driving
  duration (× `ROUTE_DURATION_SCALE`); each place gets an equal slice of that budget,
  filled with local artists' top tracks. So a 6-hour drive yields ~6 hours of music.

**Out of scope for v1**
- Live/GPS reactivity (music changing as you physically move).
- **Per-song pacing** — syncing an individual song to the moment you are physically in
  that region. v1 matches the *total* length to the drive, not song-by-song position;
  true pacing needs the live mode.
- A self-built artist-origin catalog (we query live APIs first — see §4).
- A polished consumer UI. The first proof can be a script / minimal web flow.

---

## 3. How it works (pipeline)

The geographic "brain" is **provider-agnostic**. Only the final playlist-building
step differs per music service. This reflects what Phase 0 actually implements.

1. **Route A → B.** Feed start and end to [OSRM](https://project-osrm.org/) → a route
   polyline plus the estimated **drive duration** (used to size the playlist).
2. **Sample waypoints.** Walk the polyline and sample points roughly every *N* km
   (`WAYPOINT_INTERVAL_KM`), capped at `MAX_PLACES`.
3. **Reverse-geocode** each waypoint (Nominatim, English names) → a place with its
   **region and country**, for graceful widening later.
4. **Merge into segments.** Probe each place's city level once; consecutive places that
   resolve to the same effective area (e.g. several villages in one region) merge into a
   single **segment** with a `span` = how many places it covers.
5. **Gather candidates per segment.** MusicBrainz `area:` search over **local** levels
   (city/region, with early-stop) **plus always the country level** with a deeper pull
   (`COUNTRY_CANDIDATES`) — famous nationals sit below a wall of classical composers in
   MusicBrainz, so country needs digging. Cached per area query across the route.
6. **Resolve each candidate (tiered, precision-first).** (a) strict name match — accept a
   Spotify result only if its name matches the MusicBrainz name (exact legends pass,
   famous-stranger hijacks don't); (b) on failure, the artist's MusicBrainz-stored
   **Spotify link** for an exact resolution (bounded per segment); (c) else a **guarded
   loose** match — the top fuzzy result, accepted only if its popularity ≤
   `LOOSE_FALLBACK_MAX_POP` so a superstar can't hijack an obscure local.
7. **Rank & filter.** Rank the whole pool by Spotify **popularity** (well-known songs
   lead, blending local + national); drop artists/tracks below popularity floors, drop
   non-music (audiobooks/children's) and classical (excluded by default — see §3a).
8. **Fill time slices.** Each segment gets a slice of the drive-time budget proportional
   to its `span`, filled from the ranked tracks; tracks are de-duplicated playlist-wide
   by normalized title.
9. **Assemble in travel order** → create the playlist in the chosen service.

```
A,B ─▶ route(+duration) ─▶ waypoints ─▶ reverse-geocode ─▶ merge into segments
                                                                    │
              per segment: MB area search — local (city/region) + always country (deep)
                                                                    │
        resolve tiered: strict name → MB Spotify-link → guarded loose (pop ceiling)
                                                                    │
            rank by popularity · floors · non-music & classical & dedup filters
                                                                    │
                  fill each segment's time slice (∝ span) ─▶ create playlist
```

### 3a. Why classical detection uses names/titles, not genres

Spotify's genre tags are unreliable — the same `/artists` request returns
`["classical"]` one moment and `[]` the next (genres are being deprecated). So
classical/opera is detected from **stable** signals instead: credited artist *names*
("Symphony Orchestra", "Philharmonic", "Orchestre") and *title* patterns (catalogue
numbers like BWV/Op., key signatures like "in C-Sharp Minor", movement names like
Allegro/Gymnopédie). All credited artists on a track are vetted, not just the matched
one — so a narrated symphonic piece credited to an orchestra + narrator is caught.

---

## 4. Data sources

Decided during brainstorm. Two responsibilities, two sources:

| Responsibility | Source | Notes |
|---|---|---|
| **Artist origin** ("from where?") | **MusicBrainz** (live API) | Open, free, has area/geo hierarchy. Searchable by `area:`. |
| **Playable tracks + popularity** | **Spotify** (then Apple Music) | Catalog, playback, popularity score for ranking. |

**Explicitly decided:**
- **No Wikidata.** Skipped to keep v1 lean.
- **No self-built catalog yet.** Prototype with **live API calls first**, optimize
  later. If/when rate limits or coverage become the bottleneck, revisit building a
  local geo-queryable catalog (e.g. bulk MusicBrainz ingest → PostGIS).
- **Do not rely on Spotify/Apple for origin data** — they have no reliable hometown
  field. Origin comes from MusicBrainz; tracks come from the music service. Match by
  artist name (and MusicBrainz ID where available).

### "Where is an artist from"?

A canonical rule keeps results consistent. Proposed default:
*place of formation (bands) / birthplace (solo)* → fallback to *current base*.
To be finalized during the build (see §7 open questions).

---

## 5. Music-service abstraction

Design for both services from the start via one small interface; implement Spotify
first, Apple Music second. The upstream geo pipeline is shared and unchanged.

```
MusicProvider:
  searchArtist(name)            -> provider artist ID (or null)
  getTopTrack(artistId)         -> track URI / ID
  createPlaylist(name)          -> playlist ID
  addTracks(playlistId, [ids])  -> void
```

**Service differences that matter:**

| | Spotify | Apple Music |
|---|---|---|
| Dev account | Free to create an app | **Apple Developer Program — ~$99/yr** |
| Subscription | **App owner must have Premium** (even just to create/fill playlists — Web API returns `403` otherwise) | Apple Music subscription |
| App auth | OAuth client secret | Signed JWT developer token |
| User auth | OAuth redirect flow | MusicKit → Music User Token |
| Popularity score | Yes (used for ranking) | No equivalent |
| Effort for first build | Low | Higher (JWT signing, MusicKit) |

> **Correction to an earlier assumption:** creating a Spotify *app* is free, but the
> Web API now requires the **app owner's account** to have an active Premium
> subscription — even for non-playback calls like creating and filling a playlist. A
> non-Premium owner gets `403 Active premium subscription required for the owner of the
> app`. Premium is therefore a hard prerequisite, not just a future live-mode concern.

**Consequences:**
- Build **Spotify first** behind the interface — it's free, fast, and provides the
  popularity score used to rank "which artists are worth including."
- For Apple Music, either reuse the Spotify-derived ranking for the artist list, or
  fall back to chart/play-count heuristics. Add the $99 / JWT setup only once the
  concept is proven.

---

## 6. Hosting & deployment

### v1: on-prem (Hidde's home server — Ubuntu + Dokploy + Tailscale)

The first deployment runs on Hidde's own server, consistent with how other personal
services are hosted in the [thuishaven](https://github.com/thuishaven/thuishaven)
ecosystem.

- **Runtime**: a container, deployed via **Dokploy**.
- **Exposure**: **public domain via Cloudflare Tunnel**. A public URL is required
  regardless of preference because **Spotify OAuth needs a reachable redirect URI**
  (and Apple Music's MusicKit needs an HTTPS origin). Tailnet-only is not sufficient
  for the auth callback.
- **Secrets**: Spotify (and later Apple) credentials supplied as environment
  variables / Dokploy secrets — never committed.

### "Available for use on Thuishaven"

Thuishaven is a library of opinionated self-hosting **patterns**, not a hosting
platform — it documents recipes, it does not run containers. So making geo-music
"available on Thuishaven" means:

> Write a Thuishaven **pattern** (category `media`) that documents how to self-host
> geo-music end-to-end: container, Dokploy deploy, Cloudflare Tunnel exposure,
> Spotify/Apple credential setup, and gotchas.

This lets anyone with a server follow the same recipe. The pattern lives in the
`thuishaven/thuishaven` repo and is contributed once geo-music itself is validated
on Hidde's server (dogfood-first, matching Thuishaven's `experimental → stable`
lifecycle). *(Interpretation — confirm with maintainer; see §8.)*

---

## 7. Build plan

Phased, smallest-magic-first. Stop and review after each phase.

### Phase 0 — Smallest thing that proves the magic ✅ DONE
A CLI: input two cities → an ordered Spotify playlist whose artists march
geographically A→B, sized to the drive time. No app, no UI, no GPS. Validated on real
routes (Amsterdam→Paris, Munich→Milan). What shipped, beyond the minimal proof:

- OSRM routing (+ drive duration) + Nominatim geocoding (region/country) — keyless.
- Segment merging weighted by route coverage; city→region→country fallback.
- MusicBrainz area search; `MusicProvider` interface + **Spotify** implementation.
- Spotify OAuth (loopback + a manual helper for headless setups), token cache/refresh.
- **Quality pipeline**: rank by Spotify popularity, popularity floor, classical cap,
  non-music filter (audiobooks/children's), playlist-wide track de-duplication.
- `--dry-run` preview (geo + artists, no credentials needed).
- All behaviour tunable via env (see `.env.example` / README table).

Finding from real-route testing: music-rich **cities and strong national scenes**
(Italy, France, German cities) come out great; **sparse rural/alpine regions** are noisy
because MusicBrainz `area:` tagging is thin there — the artist-origin data problem (§8).

### Phase 1 — Shared geo pipeline + Spotify provider ✅ folded into Phase 0
The geo pipeline, MusicBrainz search, `MusicProvider` interface, Spotify implementation,
ranking, and OAuth all landed in Phase 0. Remaining Phase-1-ish polish lives in §8.

### Phase 2 — On-prem deployment
1. Containerize.
2. Deploy via Dokploy on the home server.
3. Expose via Cloudflare Tunnel on a public domain; wire OAuth redirect.

### Phase 3 — Apple Music provider
1. Apple Developer account + developer token (JWT) + MusicKit user auth.
2. Second `MusicProvider` implementation; reuse ranking strategy.

### Phase 4 — Thuishaven pattern
1. Author the `media` pattern in `thuishaven/thuishaven` documenting the self-host
   recipe; start `experimental`, promote to `stable` after validation.

### Known tradeoffs (as built)
- MusicBrainz / Nominatim / OSRM rate limit (~1 req/s) and a deep country pull → a run
  takes a few minutes.
- **Sparse rural/alpine regions under-fill.** Resolution is precision-first (strict +
  guarded loose), so segments with few correctly-resolvable artists come up short. A
  music-rich route fills far better than an Alpine one. Tunable via
  `LOOSE_FALLBACK_MAX_POP` (fullness vs. precision).
- **MusicBrainz country results are classical-dominated.** `area:"Italy"`/`"Austria"`
  return composers first; the deep country pull + classical exclusion + popularity
  ranking surface the recognizable pop nationals (Mina, Falco, Hallyday).
- Playlist length tracks the *total* drive, not per-song position (no live pacing).

---

## 8. Open questions & next work

**Resolved in Phase 0**
- *Tech stack*: TypeScript / Node 20. ✅
- *Routing/geocoding provider*: OSRM + Nominatim (keyless). ✅
- *Ranking & blend*: popularity-ranked blend of local + regional + national; well-known
  songs lead. ✅
- *Wrong matches*: tiered resolution (strict name → MB Spotify-link → guarded loose with
  a popularity ceiling) killed the famous-stranger hijack (e.g. "MOLLY" → Molly Santana,
  Drake-in-Tyrol). ✅
- *Playlist size*: targets drive time, per-segment slice ∝ route coverage. ✅

**Still open**
1. **Sparse-region recall (the big one).** The wrong-match noise is gone, but sparse
   rural/alpine areas now *under-fill* — there simply aren't many correctly-resolvable
   local artists, and famous nationals are tagged at country level behind a classical
   wall. The deep country pull helps; the real ceiling is the artist-origin
   **data-quality** problem flagged in §1 as the only moat. Options: build a better
   origin source (bulk MusicBrainz + enrichment, the deferred "own catalog"); a
   notion of *scene/vibe* (what a place is musically known for) alongside *origin*;
   or accept shorter-but-correct playlists on sparse routes.
2. **Canonical "from" rule** (§4): birthplace/formation vs current base — still relying
   on MusicBrainz's `area:` as-is.
3. **Slice weighting**: currently ∝ number of places merged; could weight by *dwell
   time* (traffic/stops) or an area's *artist density*.
4. **Non-local noise**: artists loosely tagged to a country still ride country fallback;
   needs tighter origin verification.
5. **"Available on Thuishaven" interpretation** (§6): confirmed — a Thuishaven `media`
   pattern. (Phase 4.)
6. **Domain / subdomain** for the public OAuth-callback URL (Phase 2 deployment).
7. **Future — live/GPS reactivity**: revisit after the static experience is proven.
