# geo-music — Project Specification

> Turn a road trip into a soundtrack of place. Given a start and an end, geo-music
> builds a playlist of artists *from* the towns you drive through, ordered along the
> route — so when you roll into Amsterdam, you hear Amsterdam.

**Status**: pre-prototype (spec only)
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
step differs per music service.

1. **Route A → B.** Feed start and end to a routing API → a route polyline.
   - Candidate: [OSRM](https://project-osrm.org/) (free/open) or Google Directions.
2. **Sample waypoints.** Walk the polyline and sample points roughly every *N* km;
   keep meaningful towns/cities, not raw GPS points.
3. **Reverse-geocode** each waypoint → a place name (city / town / region).
4. **Find local artists per place.** Query MusicBrainz by area, e.g. `area:Amsterdam`,
   to get artists associated with that place. (See §4.)
5. **Rank & pick a track per artist.** Resolve each artist in the music service,
   rank by popularity, take a representative (top) track.
6. **Assemble in route order.** Concatenate per-place track lists in travel order
   → create the playlist in the chosen service.

```
A,B ──▶ route ──▶ waypoints ──▶ reverse-geocode ──▶ [places]
                                                        │
                                  per place: MusicBrainz area search
                                                        │
                                            rank by popularity, pick top track
                                                        │
                              assemble in travel order ──▶ create playlist
```

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

### Phase 0 — Smallest thing that proves the magic
A script: input two cities → output an ordered Spotify playlist whose artists march
geographically A→B. No app, no UI, no GPS. If this feels good on a real drive, the
idea is validated. Everything else is scaling and polish.

### Phase 1 — Shared geo pipeline + Spotify provider
1. Routing + waypoint sampling + reverse-geocoding (§3 steps 1–3).
2. MusicBrainz area search per place (§3 step 4).
3. `MusicProvider` interface; **Spotify** implementation (§5).
4. Ranking + track selection + playlist assembly (§3 steps 5–6).
5. Spotify OAuth flow with a public redirect URI.

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

### Known tradeoffs accepted for v1
- MusicBrainz rate limit (~1 req/s) → keep routes short, sample few waypoints, cache
  aggressively.
- `area:` search is name-based and fuzzy → keep only real cities/towns; skip junk.
- MusicBrainz → music-service name matching is lossy → tolerate occasional wrong
  matches in the prototype.
- Sparse regions produce gaps → a playlist with gaps is fine for v1.

---

## 8. Open questions

1. **Tech stack.** TypeScript / Node 20 is the natural choice (matches the Thuishaven
   org's stack and keeps a path to code reuse). Confirm before Phase 1.
2. **Canonical "from" rule** (§4): formation/birthplace → current base? Finalize.
3. **Routing + reverse-geocoding provider**: OSRM (free/open) vs Google Directions
   (better data, paid/keyed). Pick for Phase 1.
4. **Waypoint density** (`N` km between samples) and how to decide a place is
   "notable enough" to include.
5. **Ranking & size**: playlist length now targets drive time with an equal slice per
   place (implemented). Still open: weight slices by *dwell time* (traffic/stops) or by
   an area's *artist density*; rank artists by Spotify popularity rather than MusicBrainz
   relevance; a distance radius that expands until it finds *something*.
6. **"Available on Thuishaven" interpretation** (§6): confirm it means a Thuishaven
   `media` pattern, not some other integration.
7. **Domain / subdomain** for the public OAuth-callback URL.
8. **Future — live/GPS reactivity**: revisit after v1 proves the static experience.
