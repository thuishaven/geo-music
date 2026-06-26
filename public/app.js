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

  resultEl.scrollIntoView({ behavior: "smooth" });
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
  setStatus("Routing, finding local artists, and building your playlist… this takes a minute or two.");
  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    setStatus("");
    renderResult(data);
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
