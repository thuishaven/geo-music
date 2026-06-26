# Deployment

How to run the geo-music web app, locally and on an on-prem server (Dokploy +
Cloudflare Tunnel). The app is a single long-lived HTTP service with per-visitor
Spotify OAuth — anyone can connect their own account and build a playlist.

## What you need

- A **Spotify app** ([developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)).
  The app **owner's account must have Spotify Premium** — the Web API returns
  `403` otherwise (see the README note).
- The app's **Client ID** and **Client Secret**.
- A **public HTTPS origin** for production (the OAuth callback can't be a tailnet-only
  host). We use a Cloudflare Tunnel to a subdomain.

## 1. Register the redirect URIs (Spotify dashboard)

Under the app's **Settings → Redirect URIs**, add the callback for each origin you run:

| Origin | Redirect URI |
|---|---|
| Local dev | `http://127.0.0.1:8080/auth/callback` |
| Production | `https://<your-domain>/auth/callback` |

The app derives the callback from `PUBLIC_BASE_URL`, so it must match exactly.

> While the app is in **Development Mode**, only allow-listed Spotify accounts (the
> owner + up to 25 you add) can connect. Request **Extended Quota Mode** to open it to
> everyone.

## 2. Run locally with Docker

```bash
export SPOTIFY_CLIENT_ID=...
export SPOTIFY_CLIENT_SECRET=...
export PUBLIC_BASE_URL=http://127.0.0.1:8080
docker compose up --build
```

Open <http://127.0.0.1:8080>, click **Connect Spotify**, then build a playlist. (Without
Docker: `npm ci && npm run build && npm run serve:prod`, or `npm run serve` for dev.)

## 3. Deploy on the home server (Dokploy)

1. **Create the application** in Dokploy from this Git repo (it builds the `Dockerfile`).
2. **Environment variables** (Dokploy → the app → Environment):

   | Var | Value |
   |---|---|
   | `SPOTIFY_CLIENT_ID` | from the Spotify app |
   | `SPOTIFY_CLIENT_SECRET` | from the Spotify app |
   | `PUBLIC_BASE_URL` | `https://<your-domain>` (no trailing slash) |
   | `SPOTIFY_MARKET` | e.g. `NL` (optional) |

   Tuning knobs from `.env.example` (`COUNTRY_CANDIDATES`, `LOOSE_FALLBACK_MAX_POP`, …)
   are all optional overrides.
3. The container listens on **`8080`**. Point Dokploy's proxy/domain at that port.

## 4. Expose publicly (Cloudflare Tunnel)

Route a public hostname to the container so the OAuth callback is reachable over HTTPS:

1. In your Cloudflare Tunnel config, add a public hostname `<your-domain>` → the
   Dokploy service (e.g. `http://localhost:8080` on the host, or the container's
   service address).
2. Set `PUBLIC_BASE_URL=https://<your-domain>` and make sure that
   `…/auth/callback` is registered in the Spotify app (step 1).
3. Redeploy. Visit `https://<your-domain>`, connect Spotify, build a playlist.

## Operational notes

- **Sessions are in-memory.** A restart logs everyone out (they just reconnect Spotify).
  Fine for a single instance; use a shared store if you ever run multiple replicas.
- **Secrets** live only in environment variables — never commit `.env` or
  `.spotify-token.json` (both are git-ignored). The `.spotify-token.json` file is for the
  **CLI** only; the web app stores tokens per session, not on disk.
- **A build takes a minute or two per request** (MusicBrainz/Nominatim are rate-limited
  to ~1 req/s and the country pull is deep). The UI shows a working state meanwhile.
- **Rebuild to update**: Dokploy redeploys on push (if enabled) or on manual trigger.

## Relation to Thuishaven

Per [SPEC §6](../SPEC.md), making geo-music "available on Thuishaven" means publishing a
Thuishaven **pattern** (category `media`) that documents this self-host recipe, once the
deployment is validated on the home server. This file is the basis for that pattern.
