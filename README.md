# geo-music

> Turn a road trip into a soundtrack of place. Give it a start and an end, and
> geo-music builds a playlist of artists *from* the towns you drive through,
> ordered along your route — so when you roll into Amsterdam, you hear Amsterdam.

**Status:** pre-prototype. This repo currently holds the spec only.

## The idea

A journey is a sequence, and music is tied to place. geo-music fuses them: a static,
route-ordered playlist where artists' origins march geographically from A to B. Built
for road trips, scenic drives, and tourism — your soundtrack changes as the landscape
does.

## How it works (in short)

1. Route A → B and sample the towns you pass through.
2. For each place, find artists *from* there (via [MusicBrainz](https://musicbrainz.org/)).
3. Pick a representative track per artist (via Spotify, later Apple Music).
4. Assemble the tracks in travel order → a playlist in your music service.

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

Output is an ordered playlist whose artists march geographically from start to end.

> **Prototype tradeoffs** (see SPEC §7): MusicBrainz / Nominatim / OSRM are rate-limited
> to ~1 req/s, so the CLI throttles itself and caps the number of places (`MAX_PLACES`).
> Artist→place matching is fuzzy and sparse regions are skipped — gaps are expected.

### Project layout

```
src/
  index.ts            CLI entry
  pipeline.ts         orchestrates route → places → artists → playlist
  config.ts           env + tuning
  geo/                routing (OSRM), geocoding (Nominatim), waypoint sampling
  origin/             artist-origin lookup (MusicBrainz area search)
  providers/          MusicProvider interface + Spotify implementation
```

## License

[MIT](LICENSE)
