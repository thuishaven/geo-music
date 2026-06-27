import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { authorizeUrl, exchangeCode } from "../providers/spotify-oauth.js";
import { SpotifyProvider } from "../providers/spotify.js";
import { buildPlaylist } from "../pipeline.js";
import { createSession, getSession } from "./sessions.js";
import { createJob, getJob } from "./jobs.js";

const CALLBACK = `${config.web.publicBaseUrl}/auth/callback`;
const COOKIE = "gm_sid";
const SECURE = config.web.publicBaseUrl.startsWith("https");

const app = new Hono();

// --- Spotify OAuth (each visitor connects their own account) ---

app.get("/auth/login", (c) => {
  const { sid, session } = createSession();
  const state = randomBytes(8).toString("hex");
  session.oauthState = state;
  setCookie(c, COOKIE, sid, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return c.redirect(authorizeUrl(state, CALLBACK));
});

app.get("/auth/callback", async (c) => {
  const session = getSession(getCookie(c, COOKIE));
  const { code, state, error } = c.req.query();
  if (error) return c.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!session || !code || !state || state !== session.oauthState) {
    return c.redirect("/?error=oauth_state");
  }
  session.oauthState = undefined;
  session.token = await exchangeCode(code, CALLBACK);
  return c.redirect("/");
});

app.post("/auth/logout", (c) => {
  const session = getSession(getCookie(c, COOKIE));
  if (session) session.token = undefined;
  return c.json({ ok: true });
});

// --- API ---

app.get("/api/me", (c) => {
  const session = getSession(getCookie(c, COOKIE));
  return c.json({ connected: Boolean(session?.token) });
});

// Start a build as a background job and return its id immediately — the build
// runs for minutes, longer than a proxied connection stays open.
app.post("/api/build", async (c) => {
  const session = getSession(getCookie(c, COOKIE));
  if (!session?.token) return c.json({ error: "Connect Spotify first." }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { from?: string; to?: string };
  const from = (body.from ?? "").trim();
  const to = (body.to ?? "").trim();
  if (!from || !to) return c.json({ error: "Provide both a start and an end." }, 400);

  const provider = new SpotifyProvider(session.token, (t) => {
    session.token = t; // persist refreshed tokens back to the session
  });
  const { id, job } = createJob(Date.now());
  void (async () => {
    try {
      await provider.authenticate();
      const result = await buildPlaylist(provider, from, to);
      job.status = "done";
      job.plan = result.plan;
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    }
  })();
  return c.json({ jobId: id }, 202);
});

// Poll a build job.
app.get("/api/build/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "Unknown or expired job." }, 404);
  if (job.status === "running") return c.json({ status: "running" });
  if (job.status === "error") return c.json({ status: "error", error: job.error });
  return c.json({ status: "done", plan: job.plan });
});

// --- Static frontend ---

app.get("/", async (c) => c.html(await readFile("./public/index.html", "utf8")));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.web.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`geo-music web → listening on 0.0.0.0:${info.port}  (callback: ${CALLBACK})`);
});
