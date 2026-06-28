/* global L */

const $ = (sel) => document.querySelector(sel);

const accountEl = $("#account");
const form = $("#build-form");
const buildBtn = $("#build-btn");
const statusEl = $("#status");
const resultEl = $("#result");
const timelineEl = $("#timeline");

let map;
let markers = [];

/** Format a millisecond offset as "23 min" or "1h 23m into the drive". */
function formatOffset(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

async function refreshAccount() {
  const { connected } = await fetch("/api/me").then((r) => r.json());
  if (connected) {
    accountEl.innerHTML = `<button class="ghost" id="logout">Disconnect</button>`;
    $("#logout").onclick = async () => {
      await fetch("/auth/logout", { method: "POST" });
      refreshAccount();
    };
    form.hidden = false;
    $("#form-hint").textContent = "";
    buildBtn.disabled = false;
  } else {
    accountEl.innerHTML = `<a class="spotify-link" href="/auth/login">Connect Spotify</a>`;
    form.hidden = false;
    buildBtn.disabled = true;
    $("#form-hint").textContent = "Connect your Spotify account to build a playlist.";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a build job until it finishes, updating the status with elapsed time. */
async function pollBuild(jobId, started) {
  for (;;) {
    await sleep(3000);
    const r = await fetch(`/api/build/${jobId}`);
    const d = await r.json();
    if (!r.ok || d.status === "error") throw new Error(d.error || "Build failed.");
    if (d.status === "done") return d.plan;
    const secs = Math.round((Date.now() - started) / 1000);
    setStatus(`Building your playlist… ${secs}s (routing, local artists, ranking — a few minutes is normal).`);
  }
}

function setStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", isError);
}

function renderResult(plan) {
  resultEl.hidden = false;
  $("#result-summary").innerHTML =
    `<strong>${plan.from} → ${plan.to}</strong> · ${plan.distanceKm} km · ~${plan.durationMin} min drive · ${plan.tracks.length} tracks`;
  $("#open-spotify").href = plan.url;

  // Map
  if (!map) {
    map = L.map("map", { scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 18,
    }).addTo(map);
  }
  markers.forEach((m) => m.remove());
  markers = [];

  const line = L.polyline(plan.route, { color: "#1db954", weight: 3, opacity: 0.5 }).addTo(map);
  markers.push(line);

  // A small dot per track, spread along the route by when you'll hear it.
  const trackDots = [];
  plan.tracks.forEach((t, i) => {
    const dot = L.circleMarker([t.lat, t.lon], {
      radius: 4,
      weight: 0,
      fillColor: "#1db954",
      fillOpacity: 0.55,
    })
      .bindPopup(`<b>${escapeHtml(t.artist)}</b><br>${escapeHtml(t.title)}<br><small>${formatOffset(t.offsetMs)} in</small>`)
      .addTo(map);
    trackDots[i] = dot;
    markers.push(dot);
  });
  window.__trackDots = trackDots;

  // Larger labelled markers for the places.
  plan.places.forEach((p) => {
    const mk = L.circleMarker([p.lat, p.lon], {
      radius: 6,
      color: "#0f1115",
      weight: 2,
      fillColor: "#1db954",
      fillOpacity: 1,
    })
      .bindTooltip(p.name, { permanent: false })
      .addTo(map);
    markers.push(mk);
  });
  map.fitBounds(line.getBounds(), { padding: [30, 30] });

  // Timeline
  timelineEl.innerHTML = "";
  plan.tracks.forEach((t, i) => {
    const li = document.createElement("li");
    li.innerHTML =
      `<div><div class="when">${formatOffset(t.offsetMs)}</div><div class="place">${t.place}</div></div>` +
      `<div class="track"><span class="artist">${escapeHtml(t.artist)}</span> — <span class="title">${escapeHtml(t.title)}</span></div>`;
    li.onclick = () => {
      timelineEl.querySelectorAll("li").forEach((x) => x.classList.remove("active"));
      li.classList.add("active");
      map.panTo([t.lat, t.lon]);
      const dot = window.__trackDots && window.__trackDots[i];
      if (dot) dot.openPopup();
    };
    timelineEl.appendChild(li);
  });

  // Embedded Spotify player (works for anyone on public playlists — the demos).
  const embedEl = $("#embed");
  embedEl.innerHTML = plan.playlistId
    ? `<iframe title="Spotify player" style="border-radius:12px" src="https://open.spotify.com/embed/playlist/${plan.playlistId}?theme=0" width="100%" height="352" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`
    : "";

  setupPlayer(plan);
  resultEl.scrollIntoView({ behavior: "smooth" });
}

/** Load the pre-built demo journeys into the gallery (no login required). */
async function loadGallery() {
  try {
    const demos = await fetch("/demo/index.json").then((r) => (r.ok ? r.json() : []));
    if (!demos.length) return;
    const gallery = $("#gallery");
    const cards = $("#gallery-cards");
    gallery.hidden = false;
    cards.innerHTML = "";
    demos.forEach((d) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "demo-card";
      card.innerHTML = `<span class="route">${escapeHtml(d.from)} → ${escapeHtml(d.to)}</span><span class="meta">${d.tracks} tracks · play & explore</span>`;
      card.onclick = async () => {
        setStatus("Loading demo…");
        try {
          const plan = await fetch(`/demo/${d.slug}.json`).then((r) => r.json());
          setStatus("");
          renderResult(plan);
        } catch {
          setStatus("Could not load that demo.", true);
        }
      };
      cards.appendChild(card);
    });
  } catch {
    /* no gallery; ignore */
  }
}

/** Haversine distance (km) between two [lat, lon] points. */
function hav(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]);
  const la2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let flyRAF = null;

/** Scrubber + "Fly the route" playhead over the journey's timeline. */
function setupPlayer(plan) {
  const playerEl = $("#player");
  const scrubber = $("#scrubber");
  const flyBtn = $("#fly-btn");
  const readout = $("#playhead-readout");
  const route = plan.route;
  const tracks = plan.tracks;

  if (flyRAF) cancelAnimationFrame(flyRAF), (flyRAF = null);
  if (!tracks.length || route.length < 2) {
    playerEl.hidden = true;
    return;
  }
  playerEl.hidden = false;
  flyBtn.textContent = "▶ Fly the route";

  const totalMs = tracks[tracks.length - 1].offsetMs + tracks[tracks.length - 1].durationMs;

  // Precompute cumulative distances so positioning the playhead is cheap.
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + hav(route[i - 1], route[i]));
  const totalDist = cum[cum.length - 1] || 1;
  const at = (frac) => {
    if (frac <= 0) return route[0];
    if (frac >= 1) return route[route.length - 1];
    const tgt = frac * totalDist;
    let i = 1;
    while (i < route.length && cum[i] < tgt) i++;
    const p = cum[i - 1];
    const seg = cum[i] - p || 1;
    const t = (tgt - p) / seg;
    const a = route[i - 1];
    const b = route[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  const playhead = L.circleMarker(at(0), {
    radius: 8,
    color: "#ffffff",
    weight: 3,
    fillColor: "#1db954",
    fillOpacity: 1,
  }).addTo(map);
  markers.push(playhead);

  // For the "fly" camera: zoom in a couple levels and restore the overview after.
  const routeBounds = L.latLngBounds(route);
  const followZoom = Math.min(map.getBoundsZoom(routeBounds) + 2, 11);
  const restoreOverview = () => map.fitBounds(routeBounds, { padding: [30, 30] });

  const trackIndexAt = (ms) => {
    let idx = 0;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].offsetMs <= ms) idx = i;
      else break;
    }
    return idx;
  };

  const lis = () => timelineEl.querySelectorAll("li");
  function update(ms) {
    playhead.setLatLng(at(totalMs ? ms / totalMs : 0));
    const idx = trackIndexAt(ms);
    const t = tracks[idx];
    readout.innerHTML =
      `${formatOffset(ms)} in · <span class="rd-place">${escapeHtml(t.place)}</span> · ♪ ` +
      `${escapeHtml(t.artist)} — ${escapeHtml(t.title)}`;
    lis().forEach((x, i) => x.classList.toggle("active", i === idx));
    const active = lis()[idx];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function stopFly() {
    const wasFlying = Boolean(flyRAF);
    if (flyRAF) cancelAnimationFrame(flyRAF);
    flyRAF = null;
    flyBtn.textContent = "▶ Fly the route";
    if (wasFlying) restoreOverview(); // back to the whole-route view
  }

  scrubber.oninput = () => {
    stopFly();
    update((scrubber.value / 1000) * totalMs);
  };

  const FLY_MS = 24000; // ~24s to fly the whole route
  flyBtn.onclick = () => {
    if (flyRAF) return stopFly();
    flyBtn.textContent = "⏸ Stop";
    const startVal = Number(scrubber.value) >= 1000 ? 0 : Number(scrubber.value);
    const startMs = (startVal / 1000) * totalMs;
    const t0 = performance.now();
    const frame = (now) => {
      const ms = startMs + ((now - t0) / FLY_MS) * totalMs;
      if (ms >= totalMs) {
        scrubber.value = 1000;
        update(totalMs);
        stopFly();
        return;
      }
      scrubber.value = String((ms / totalMs) * 1000);
      update(ms);
      map.setView(at(ms / totalMs), followZoom, { animate: false }); // follow the playhead
      flyRAF = requestAnimationFrame(frame);
    };
    flyRAF = requestAnimationFrame(frame);
  };

  scrubber.value = "0";
  update(0);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const from = $("#from").value.trim();
  const to = $("#to").value.trim();
  if (!from || !to) return;

  buildBtn.disabled = true;
  resultEl.hidden = true;
  const started = Date.now();
  setStatus("Routing, finding local artists, and building your playlist… this takes a few minutes.");
  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    const plan = await pollBuild(data.jobId, started);
    setStatus("");
    renderResult(plan);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    buildBtn.disabled = false;
  }
});

// URL ?error= from the OAuth redirect
const params = new URLSearchParams(location.search);
if (params.get("error")) {
  setStatus(`Spotify connection failed (${params.get("error")}). Try again.`, true);
  history.replaceState({}, "", "/");
}

refreshAccount();
loadGallery();
