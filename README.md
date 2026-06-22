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

## License

[MIT](LICENSE)
