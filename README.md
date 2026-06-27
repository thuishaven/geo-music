# geo-music

> Turn a road trip into a soundtrack of place. Give it a start and an end, and
> geo-music builds a playlist of artists *from* the towns you drive through,
> ordered along your route — so when you roll into Amsterdam, you hear Amsterdam.

**Status:** Phase 0 prototype working (Spotify). A CLI builds the playlist end-to-end;
see [Running the Phase 0 prototype](#running-the-phase-0-prototype).

## The idea

A journey is a sequence, and music is tied to place. geo-music fuses them: a static,
route-ordered playlist where artists' origins march geographically from A to B. Built
for road trips, scenic drives, and tourism — your soundtrack changes as the landscape
does.

## How it works

1. **Route** A → B (OSRM) and sample waypoints along the way; the drive duration sizes
   the playlist.
2. **Reverse-geocode** each waypoint to a place with its region + country (Nominatim).
3. **Merge** consecutive places that resolve to the same area into segments, each
   weighted by how much of the drive it covers.
4. **Find artists** per segment via [MusicBrainz](https://musicbrainz.org/) area search —
   gathering **local** (city/region) acts *and always the* **country** *level* (deeper
   pull, since famous nationals sit below a wall of classical composers in MusicBrainz).
5. **Resolve each artist on Spotify** in precision order — see below — then **rank the
   whole pool by popularity** so well-known songs lead, blending local and national.
6. **Fill each segment's time slice** with the ranked tracks (length ≈ drive time) and
   **assemble in travel order** → a playlist in your music service (Spotify; Apple
   Music next).

### Resolving artists correctly (avoiding wrong matches)

MusicBrainz gives candidate *names*; resolving them to Spotify naively lets a famous
stranger hijack an obscure local ("MOLLY" → "Molly Santana"). So each candidate is
resolved in tiers:

1. **Strict name match** — accept a Spotify result only if its name matches the
   MusicBrainz name (so exact legends like *Mina* pass, hijacks don't).
2. **MusicBrainz Spotify-link** — if strict fails, use the artist's MB-stored Spotify
   link for an exact resolution (bounded per segment; each lookup is rate-limited).
3. **Guarded loose fallback** — otherwise take the top fuzzy result, but only if its
   popularity is at/below `LOOSE_FALLBACK_MAX_POP`, so a superstar can't hijack a local.

### Quality filters

- **Popularity floors** on both artist and track (drop obscure noise / novelty cuts).
- **Classical/opera excluded** by default — detected from *stable* signals (credited
  artist names like "Symphony Orchestra", and title patterns like BWV/Op./"in C-Sharp
  Minor"), because Spotify's genre tags are unreliable (the same request flips between
  `classical` and `[]`).
- **Non-music removed** — audiobooks, audio-dramas, children's spoken word (by genre,
  chapter-style titles, and non-music co-credits like narrators).
- **Track de-duplication** across the whole playlist (normalized title, so the same
  recording can't reappear via a different credit or remix).

All thresholds are tunable via env (see the table below and `.env.example`).

## Status & roadmap

- **CLI** (Phase 0): build a route-ordered playlist from the terminal.
- **Web app** (Phase 2): a multi-user web UI — connect your own Spotify, enter a route,
  and get a **map of the journey with a track-by-track timeline** (when you'll hear what,
  and where). `npm run serve`; deploy with the included `Dockerfile`.
- **Next:** Apple Music as a second provider; a [Thuishaven](https://github.com/thuishaven/thuishaven)
  `media` pattern documenting the self-host recipe. Live/GPS-reactive playback is a
  possible future direction.

See **[SPEC.md](SPEC.md)** for the full specification and **[docs/deployment.md](docs/deployment.md)**
for hosting (Dokploy + Cloudflare Tunnel).

## Running the web app

```bash
cp .env.example .env   # fill in SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
npm install
npm run serve          # → http://127.0.0.1:8080
```

Add `http://127.0.0.1:8080/auth/callback` to your Spotify app's **Redirect URIs**, open
the page, click **Connect Spotify**, and build a playlist. Each visitor connects their
own account (multi-user OAuth). For Docker/on-prem hosting see
[docs/deployment.md](docs/deployment.md).

## Running the Phase 0 prototype

A CLI that takes two places and creates a route-ordered Spotify playlist. Geo data
comes from free, keyless services (OSRM routing + Nominatim geocoding); you only need
Spotify credentials.

1. **Create a Spotify app** at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
   Add `http://127.0.0.1:8888/callback` to the app's **Redirect URIs**.
2. **Configure:**
   ```bash
   cp .env.example .env   # then fill in SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
   npm install
   ```
3. **Run** (first run opens a browser link to authorize; the token is cached locally):
   ```bash
   npm start -- "Amsterdam" "Paris"
   ```

   On a **headless / remote server** where the `127.0.0.1:8888` redirect can't reach
   your browser, authorize manually instead:
   ```bash
   npm run auth                 # prints an authorize URL
   # open it, approve, copy the code= value from the redirected address bar
   npm run auth -- "<code>"     # exchanges + caches the token
   npm start -- "Amsterdam" "Paris"
   ```

> **Spotify Premium required.** Spotify's Web API requires the **app owner's** account
> (the one that created the app in the dashboard) to have an active Premium subscription.
> A non-Premium owner gets `403 Active premium subscription required for the owner of the
> app` on the first call. Subscription changes can take a few hours to propagate.

> **This is a self-host-for-your-circle tool, by design.** A Spotify app starts in
> **Development Mode**, where only the owner plus **up to 25 allow-listed accounts** (add
> their Spotify emails under *Users and Access*) can connect. Lifting that needs Spotify's
> **Extended Quota Mode**, which now requires **250k monthly active users and a registered
> business** — out of reach for a hobby project. So there's no realistic "public service
> for anyone"; instead, you run your own instance for ~25 people, and others
> [self-host their own](docs/deployment.md) (each with their own Spotify app and its own
> 25-user budget).

Output is an ordered playlist whose artists march geographically from start to end,
**sized so its total play time is roughly the driving time**. Want to see what it would
build without creating anything? Add `--dry-run` (needs no Spotify credentials):

```bash
npm start -- --dry-run "Amsterdam" "Paris"
```

### Tuning (env, all optional)

| Var | Default | Effect |
|---|---|---|
| `ROUTE_DURATION_SCALE` | `1.0` | Playlist length vs. drive time (0.8 = shorter, 1.2 = longer) |
| `WAYPOINT_INTERVAL_KM` | `50` | Distance between sampled waypoints |
| `MAX_PLACES` | `12` | Cap on places (raise for long, cross-country routes) |
| `ARTIST_CANDIDATES_PER_PLACE` | `25` | Candidates per local (city/region) level |
| `COUNTRY_CANDIDATES` | `45` | Deeper pull at country level (digs past classical to reach nationals) |
| `MIN_ARTIST_POPULARITY` | `25` | Drop artists below this Spotify popularity |
| `MIN_TRACK_POPULARITY` | `20` | Drop individual tracks below this (novelty/narration cuts) |
| `MAX_TRACKS_PER_ARTIST` | `2` | Cap tracks from one artist |
| `MAX_CLASSICAL_PER_SEGMENT` | `0` | Classical/opera acts per segment (0 = exclude entirely) |
| `LOOSE_FALLBACK_MAX_POP` | `55` | Popularity ceiling for loose matches (lower = stricter, higher = fuller) |
| `USE_MB_LINKS` / `MAX_LINK_LOOKUPS` | `true` / `6` | Use MusicBrainz Spotify-link fallback, bounded per segment |
| `SPOTIFY_MARKET` | `NL` | Market for playable top tracks |

The two dials worth knowing: **`LOOSE_FALLBACK_MAX_POP`** trades fullness vs. precision
(how readily an unmatched name accepts a fuzzy result), and **`COUNTRY_CANDIDATES`**
controls how hard it digs for buried national acts.

> **Known limitations.** MusicBrainz / Nominatim / OSRM are rate-limited to ~1 req/s and
> the country pull is deep, so a run takes a few minutes. **Sparse rural/alpine regions**
> have few locally-tagged artists, so those segments under-fill — a music-rich route
> (e.g. Amsterdam→Paris) fills far better than an Alpine one. Resolution is conservative
> by design (precision over recall) to avoid wrong matches. Playlist length matches the
> *total* drive, but a song is not synced to your live position (that needs the live
> mode, out of scope for v1).

### Project layout

```
src/
  index.ts            CLI entry (--dry-run supported)
  pipeline.ts         route → segments → ranked artists → filled playlist
  preview.ts          --dry-run preview (no provider needed)
  segments.ts         merge consecutive same-area places, weighted by span
  config.ts           env + tuning
  geo/                routing (OSRM), geocoding (Nominatim), waypoint sampling
  origin/             artist-origin lookup (MusicBrainz area search)
  providers/          MusicProvider interface + Spotify implementation
scripts/
  spotify-auth.ts     manual OAuth helper for headless/remote setups
```

## License

[MIT](LICENSE)
