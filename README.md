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

1. **Route** A → B (OSRM) and sample waypoints along the way.
2. **Reverse-geocode** each waypoint to a place with its region + country (Nominatim).
3. **Merge** consecutive places that resolve to the same area into segments, each
   weighted by how much of the drive it covers.
4. **Find local artists** per segment via [MusicBrainz](https://musicbrainz.org/) area
   search, widening city → region → country only when a place is too sparse.
5. **Rank by Spotify popularity**, drop obscure/non-music acts, pick top tracks, and
   **fill each segment's time slice** so the playlist's length ≈ the drive time.
6. **Assemble in travel order** → a playlist in your music service (Spotify; Apple
   Music next).

Quality filters applied along the way: a popularity floor, per-segment cap on classical
acts, removal of audiobooks/audio-dramas/children's spoken word, and playlist-wide track
de-duplication. All are tunable via env (see `.env.example`).

## Status & roadmap

- **v1:** static, route-ordered playlist. **Spotify first**, Apple Music second.
- Hosted on-prem first (Dokploy + Cloudflare Tunnel); a future
  [Thuishaven](https://github.com/thuishaven/thuishaven) `media` pattern will
  document the self-host recipe.
- Live/GPS-reactive playback is a possible future direction, not part of v1.

See **[SPEC.md](SPEC.md)** for the full specification, data sources, architecture,
and build plan.

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
| `ARTIST_CANDIDATES_PER_PLACE` | `25` | Candidates considered before ranking |
| `MIN_ARTIST_POPULARITY` | `25` | Drop artists below this Spotify popularity |
| `MAX_TRACKS_PER_ARTIST` | `2` | Cap tracks from one artist |
| `MAX_CLASSICAL_PER_SEGMENT` | `2` | Cap classical/opera acts per segment |
| `SPOTIFY_MARKET` | `NL` | Market for playable top tracks |

> **Known limitations.** MusicBrainz / Nominatim / OSRM are rate-limited to ~1 req/s, so
> the CLI throttles itself — long routes take a few minutes. **Sparse rural/alpine
> regions** (few or no locally-tagged artists) fall back to region/country and can return
> a geographically loose mix — MusicBrainz's `area:` tagging is thin there. Playlist
> length matches the *total* drive, but a song is not synced to your live position (that
> needs the live mode, out of scope for v1).

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
