"use strict";

const $ = id => document.getElementById(id);
const serverUrlKey = "bragi.serverUrl";
const usernameKey = "bragi.username";
const autoShuffleKey = "bragi.autoShuffle";
const visualizerKey = "bragi.visualizer";
const state = {
  auth: null, playlists: [], selectedPlaylistId: null, controller: null, generation: 0, busy: false,
  localQueue: [], localQueueSnapshot: null, localIndex: -1, localPlayingIndex: -1, localStarting: false, localTitle: "", localArtwork: null, artworkSource: null, artworkVersion: 0,
  castContext: null, castSession: null, castSessionVersion: 0, castMedia: null, castQueue: null, castLoading: false, preparingOutput: null,
  displayedPlaylist: null, displayedIsQueue: false,
  seeking: null, volumeEditing: null, volumePending: false,
  visualizerAccess: "unchecked", localHasPlayed: false, localDirectUrl: "", playlistController: null,
  editingPlaylistId: null, editingSong: null
};
const visualizer = { context: null, source: null, analyser: null, sink: null, stream: null, frame: 0, failure: "" };

function message(text) { $("status").textContent = text; }
function log(text) {
  const item = document.createElement("li");
  item.textContent = text;
  $("activity").prepend(item);
}

function stopVisualizer() {
  if (visualizer.frame) cancelAnimationFrame(visualizer.frame);
  visualizer.frame = 0;
  if (visualizer.source) visualizer.source.disconnect();
  if (visualizer.analyser) visualizer.analyser.disconnect();
  if (visualizer.sink) visualizer.sink.disconnect();
  if (visualizer.stream) visualizer.stream.getTracks().forEach(track => track.stop());
  visualizer.source = visualizer.analyser = visualizer.sink = visualizer.stream = null;
  $("visualizer").hidden = true;
}
function prepareVisualizer() {
  if ($("visualizer-mode").value === "off") return;
  if (!window.AudioContext || typeof $("audio").captureStream !== "function") {
    visualizer.failure = "Visualizer is not supported by this browser.";
    return;
  }
  try {
    if (!visualizer.context) visualizer.context = new AudioContext();
    visualizer.failure = "";
    if (visualizer.context.state !== "running") {
      visualizer.context.resume().then(syncVisualizer, () => {
        visualizer.failure = "Visualizer could not start. Press Play to retry.";
        syncVisualizer();
      });
    }
  } catch {
    visualizer.failure = "Visualizer could not start in this browser.";
  }
}
async function prepareAudioProxy(url, signal) {
  if ($("visualizer-mode").value === "off" || visualizer.failure || !visualizer.context) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 5000);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await api("/audio-proxy", { method: "POST", body: { url }, signal: controller.signal });
    if (!result || typeof result.proxy_url !== "string" || !result.proxy_url.startsWith("/") || result.proxy_url.startsWith("//")) {
      throw new ApiError("The server returned an invalid audio proxy URL.");
    }
    const proxy = new URL(result.proxy_url, state.auth.base + "/");
    const expected = new URL(state.auth.base + "/api/v1/audio-stream");
    const params = [...proxy.searchParams];
    if (proxy.origin !== expected.origin || proxy.pathname !== expected.pathname || proxy.username || proxy.password ||
        proxy.hash || params.length !== 1 || params[0][0] !== "token" || !params[0][1]) {
      throw new ApiError("The server returned an invalid audio proxy URL.");
    }
    return proxy.href;
  } catch (error) {
    if (signal.aborted || error.status === 401) throw error;
    const reason = controller.signal.aborted ? "Request timed out." : error instanceof ApiError ? error.message : "Unexpected error.";
    log(`Could not prepare the audio proxy: ${reason} Playing directly without the visualizer.`);
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
function drawVisualizer() {
  visualizer.frame = 0;
  const canvas = $("visualizer");
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width && bounds.height && visualizer.analyser) {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      visualizer.failure = "Visualizer canvas is unavailable in this browser.";
      syncVisualizer();
      return;
    }
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8de0bd";
    ctx.globalAlpha = 0.22;
    const mode = $("visualizer-mode").value;
    if (mode === "wave") {
      const data = new Uint8Array(visualizer.analyser.fftSize);
      visualizer.analyser.getByteTimeDomainData(data);
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      data.forEach((value, i) => {
        const x = i * width / (data.length - 1);
        const y = height * (0.55 + (value - 128) / 128 * 0.3);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      const data = new Uint8Array(visualizer.analyser.frequencyBinCount);
      visualizer.analyser.getByteFrequencyData(data);
      const bars = 48, step = width / bars;
      const radius = Math.min(width, height) * 0.18;
      let frequencyBins = data.length * 0.8;
      if (mode === "bars" || mode === "mirrored") {
        frequencyBins = Math.floor(frequencyBins);
        while (frequencyBins > 1 && data[frequencyBins - 1] === 0) frequencyBins--;
      }
      if (mode === "radial") ctx.lineWidth = 3 * scale;
      for (let i = 0; i < bars; i++) {
        const band = mode === "mirrored" ? bars / 2 - 1 - Math.min(i, bars - 1 - i) : i;
        const bands = mode === "mirrored" ? bars / 2 : bars;
        const start = Math.floor(Math.pow(band / bands, 1.8) * frequencyBins);
        const end = Math.max(start + 1, Math.floor(Math.pow((band + 1) / bands, 1.8) * frequencyBins));
        let level = 0;
        for (let j = start; j < end; j++) level = Math.max(level, data[j]);
        if (mode === "radial") {
          const angle = i * 2 * Math.PI / bars;
          const length = Math.min(width, height) * 0.3 * level / 255;
          const x = Math.cos(angle), y = Math.sin(angle);
          ctx.beginPath();
          ctx.moveTo(width / 2 + x * radius, height / 2 + y * radius);
          ctx.lineTo(width / 2 + x * (radius + length), height / 2 + y * (radius + length));
          ctx.stroke();
        } else if (mode === "mirrored") {
          const barHeight = height * 0.4 * level / 255;
          const barWidth = Math.min(step, Math.max(1, step - 3 * scale));
          ctx.fillRect(i * step + (step - barWidth) / 2, height / 2 - barHeight, barWidth, barHeight * 2);
        } else {
          const barHeight = height * 0.8 * level / 255;
          ctx.fillRect(i * step, height - barHeight, Math.max(1, step - 3 * scale), barHeight);
        }
      }
    }
  }
  visualizer.frame = requestAnimationFrame(drawVisualizer);
}
function syncVisualizer() {
  const audio = $("audio");
  const mode = $("visualizer-mode").value;
  const casting = state.castContext && state.castContext.getCurrentSession();
  let notice = "";
  if (mode !== "off" && casting) notice = "Visualizer is unavailable while casting.";
  else if (mode !== "off" && audio.getAttribute("src")) {
    if (visualizer.failure) notice = visualizer.failure;
    else if (state.visualizerAccess === "blocked") notice = "Audio analysis is unavailable for this stream.";
    else if (state.visualizerAccess === "unchecked") notice = "Visualizer will be available on the next compatible track.";
    else if (!visualizer.context || visualizer.context.state !== "running") notice = "Press Play to enable the visualizer.";
  }
  $("visualizer-status").textContent = notice;
  $("visualizer-status").hidden = !notice;
  if (mode === "off" || casting || notice || document.hidden || $("library").hidden ||
      !audio.getAttribute("src") || audio.paused || audio.ended || audio.readyState < 2) {
    stopVisualizer();
    return;
  }
  if (!visualizer.source) {
    try {
      visualizer.stream = audio.captureStream();
      if (!visualizer.stream.getAudioTracks().length) throw new Error("No audio track");
      visualizer.source = visualizer.context.createMediaStreamSource(visualizer.stream);
      visualizer.analyser = visualizer.context.createAnalyser();
      visualizer.analyser.fftSize = 256;
      visualizer.sink = visualizer.context.createGain();
      visualizer.sink.gain.value = 0;
      visualizer.source.connect(visualizer.analyser);
      visualizer.analyser.connect(visualizer.sink);
      visualizer.sink.connect(visualizer.context.destination);
    } catch {
      stopVisualizer();
      visualizer.failure = "This stream could not be analyzed; browser playback is unchanged.";
      $("visualizer-status").textContent = visualizer.failure;
      $("visualizer-status").hidden = false;
      return;
    }
  }
  $("visualizer").hidden = false;
  if (!visualizer.frame) visualizer.frame = requestAnimationFrame(drawVisualizer);
}
try {
  const savedServerUrl = localStorage.getItem(serverUrlKey);
  if (savedServerUrl) {
    $("server").value = savedServerUrl;
    $("server").readOnly = true;
  }
  const savedUsername = localStorage.getItem(usernameKey);
  if (savedUsername) {
    $("username").value = savedUsername;
    $("username").readOnly = true;
  }
  const savedAutoShuffle = localStorage.getItem(autoShuffleKey);
  if (savedAutoShuffle === "true" || savedAutoShuffle === "false") $("auto-shuffle").checked = savedAutoShuffle === "true";
  else if (savedAutoShuffle !== null) message("The saved auto shuffle setting is invalid; auto shuffle is off.");
  const savedVisualizer = localStorage.getItem(visualizerKey);
  if (["bars", "mirrored", "radial", "wave", "off"].includes(savedVisualizer)) $("visualizer-mode").value = savedVisualizer;
  else if (savedVisualizer !== null) message("The saved visualizer setting is invalid; spectrum bars are selected.");
} catch {
  message("Browser storage is unavailable; the server URL, username, and settings cannot be remembered.");
}
function updateConnectionEditButton() {
  const locked = $("server").readOnly || $("username").readOnly;
  $("edit-connection").textContent = locked ? "Edit connection details" : "Lock connection details";
}
updateConnectionEditButton();
$("edit-connection").addEventListener("click", () => {
  const lock = !$("server").readOnly && !$("username").readOnly;
  $("server").readOnly = lock;
  $("username").readOnly = lock;
  updateConnectionEditButton();
});
function closeSettings() {
  $("settings-panel").hidden = true;
  $("login-panel").hidden = !!state.auth;
  $("library").hidden = !state.auth;
  $("open-settings").focus();
  syncVisualizer();
}
$("toggle-sidebar").addEventListener("click", () => {
  const sidebar = $("playlist-sidebar");
  sidebar.hidden = !sidebar.hidden;
  $("library").classList.toggle("sidebar-hidden", sidebar.hidden);
  $("toggle-sidebar").setAttribute("aria-expanded", String(!sidebar.hidden));
  const label = sidebar.hidden ? "Show playlist sidebar" : "Hide playlist sidebar";
  $("toggle-sidebar").setAttribute("aria-label", `Bragi: ${label}`);
  $("toggle-sidebar").title = label;
});
$("open-settings").addEventListener("click", () => {
  $("login-panel").hidden = true;
  $("library").hidden = true;
  $("settings-panel").hidden = false;
  $("settings-heading").focus();
  syncVisualizer();
});
$("close-settings").addEventListener("click", closeSettings);
$("auto-shuffle").addEventListener("change", () => {
  try {
    localStorage.setItem(autoShuffleKey, String($("auto-shuffle").checked));
    message("Auto shuffle setting saved.");
  } catch {
    message("Browser storage is unavailable; auto shuffle changed for this page but was not saved.");
  }
});
$("visualizer-mode").addEventListener("change", () => {
  try {
    localStorage.setItem(visualizerKey, $("visualizer-mode").value);
    message("Visualizer setting saved.");
  } catch {
    message("Browser storage is unavailable; the visualizer changed for this page but was not saved.");
  }
  if ($("visualizer-mode").value !== "off") prepareVisualizer();
  syncVisualizer();
});
function setBusy(value) {
  state.busy = value;
  $("signout").disabled = state.castLoading;
  $("new-playlist").disabled = state.castLoading || !!state.playlistController;
  const selected = state.playlists.find(playlist => playlist.id === state.selectedPlaylistId);
  $("edit-playlist").disabled = state.castLoading || !!state.playlistController || !selected;
  $("add-song").disabled = state.castLoading || !!state.playlistController || !selected;
  $("play-selected").disabled = value || state.castLoading || !selected || !selected.videos.length;
  $("edit-song-save").disabled = value || state.castLoading || !!state.playlistController;
  $("edit-song-delete").disabled = value || state.castLoading || !!state.playlistController;
  document.querySelectorAll(".track-button").forEach(button => { button.disabled = value || state.castLoading; });
  document.querySelectorAll(".edit-song").forEach(button => {
    button.disabled = value || state.castLoading || !!state.playlistController;
  });
  updatePlayer();
}
function cancelPreparation() {
  state.generation++;
  if (state.controller) state.controller.abort();
  state.controller = null;
  state.preparingOutput = null;
  if (state.localStarting) stopLocal();
  setBusy(false);
}
function stopLocal() {
  stopVisualizer();
  const audio = $("audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.localQueue = [];
  state.localQueueSnapshot = null;
  state.localIndex = -1;
  state.localPlayingIndex = -1;
  state.localStarting = false;
  state.localTitle = "";
  state.localArtwork = null;
  state.visualizerAccess = "unchecked";
  state.localHasPlayed = false;
  state.localDirectUrl = "";
  updatePlayer();
}
function signOut(text = "Signed out. Cast playback was not stopped.") {
  if (state.playlistController) {
    state.playlistController.abort();
    state.playlistController = null;
    text += " The playlist change may have completed; check your playlists after signing in.";
  }
  if ($("playlist-dialog").open) $("playlist-dialog").close();
  if ($("song-dialog").open) $("song-dialog").close();
  if ($("edit-song-dialog").open) $("edit-song-dialog").close();
  $("playlist-save").disabled = false;
  $("playlist-cancel").disabled = false;
  $("playlist-delete").disabled = false;
  $("song-save").disabled = false;
  $("song-cancel").disabled = false;
  $("edit-song-save").disabled = false;
  $("edit-song-cancel").disabled = false;
  $("edit-song-delete").disabled = false;
  state.editingPlaylistId = null;
  state.editingSong = null;
  cancelPreparation();
  stopLocal();
  state.auth = null;
  state.playlists = [];
  state.selectedPlaylistId = null;
  if (!$("settings-panel").hidden) closeSettings();
  $("password").value = "";
  $("login-panel").hidden = false;
  $("library").hidden = true;
  $("signout").hidden = true;
  $("playlists").replaceChildren();
  $("queue-status").textContent = "No playback started.";
  $("track-search").value = "";
  showTracks(null);
  setBusy(false);
  $("activity").replaceChildren();
  message(text);
}

class ApiError extends Error {
  constructor(message, status = 0, uncertain = false) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
  }
}
async function api(path, { method = "GET", body, signal, auth = state.auth } = {}) {
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, 30000);
  const abort = () => timeout.abort();
  if (signal) {
    if (signal.aborted) timeout.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  try {
    let response;
    try {
      response = await fetch(auth.base + "/api/v1" + path, {
        method, headers: { Authorization: auth.header, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: timeout.signal,
        redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
      });
    } catch (error) {
      if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError(timedOut ? "The request timed out." : "Network, TLS, CORS, mixed-content, or redirect failure.", 0, method !== "GET");
    }
    if (response.status === 401) throw new ApiError("Authentication failed. Sign in again.", 401);
    if (!response.ok) {
      const descriptions = { 400: "The server rejected the request.", 404: "The requested playlist or queue was not found.", 422: "The playlist is empty or the track could not be resolved.", 500: "The server encountered an error." };
      throw new ApiError(descriptions[response.status] || `Server returned HTTP ${response.status}.`, response.status);
    }
    if (response.status === 204) return null;
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      throw new ApiError("The server returned a non-JSON response.", response.status, method !== "GET");
    }
    try { return await response.json(); }
    catch { throw new ApiError("The server returned invalid JSON.", response.status, method !== "GET"); }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
  }
}
function reportError(error) {
  if (error.name === "AbortError") return;
  if (error.status === 401) signOut(error.message);
  else message(error.message || "An unexpected error occurred.");
}
function requireQueue(result) {
  if (!result || !result.queue || !Array.isArray(result.queue.videos)) throw new ApiError("The server returned an invalid queue.");
  return result.queue;
}
function filterTracks() {
  const playlist = state.displayedPlaylist;
  const query = $("track-search").value.trim().toLocaleLowerCase();
  let matches = 0;
  $("tracks").querySelectorAll("li").forEach((item, index) => {
    item.hidden = !playlist.videos[index].name.toLocaleLowerCase().includes(query);
    if (!item.hidden) matches++;
  });
  $("tracks-empty").hidden = matches > 0;
  $("tracks-empty").textContent = !playlist ? "Choose a playlist from your library." :
    !playlist.videos.length ? "This playlist has no tracks." : "No songs match your search.";
}
$("track-search").addEventListener("input", filterTracks);
function showTracks(playlist, isQueue = false) {
  state.displayedPlaylist = playlist;
  state.displayedIsQueue = isQueue;
  $("playlist-display-name").textContent = playlist ? playlist.name : "No playlist selected";
  $("playlist-summary").textContent = playlist
    ? ` - (${playlist.videos.length} ${playlist.videos.length === 1 ? "song" : "songs"})${isQueue ? " · server queue" : ""}` : "";
  $("tracks").replaceChildren();
  if (!playlist) {
    filterTracks();
    return;
  }
  playlist.videos.forEach((video, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-button";
    button.textContent = video.name;
    button.dataset.trackNumber = index + 1;
    button.setAttribute("aria-label", `Play ${video.name}, track ${index + 1}`);
    button.disabled = state.busy || state.castLoading;
    button.addEventListener("click", () => {
      if (isQueue) {
        startPlayback(null, { queueId: playlist.id, index });
      } else {
        const occurrence = playlist.videos.slice(0, index + 1).filter(track => track.name === video.name && track.link === video.link).length;
        startPlayback(playlist.id, { video, occurrence });
      }
    });
    item.append(button);
    if (!isQueue) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "edit-song icon-button";
      edit.setAttribute("aria-label", `Edit ${video.name}, track ${index + 1}`);
      edit.title = "Edit song";
      edit.disabled = state.busy || state.castLoading || !!state.playlistController;
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "edit";
      edit.append(icon);
      edit.addEventListener("click", () => openSongEditor(playlist, index));
      item.append(edit);
    }
    $("tracks").append(item);
  });
  filterTracks();
  updateTrackHighlight();
}
function updateTrackHighlight() {
  const displayed = state.displayedPlaylist;
  const session = state.castContext && state.castContext.getCurrentSession();
  const media = session && session.getMediaSession();
  let queue = null, index = -1;
  if (session && media && media.playerState !== "IDLE") {
    const item = Array.isArray(media.items) && media.items.find(entry => entry.itemId === media.currentItemId);
    const info = item ? item.media : media.media;
    const marker = info && info.customData && info.customData.bragiBrowser;
    if (marker && typeof marker.queueId === "string" && Number.isInteger(marker.index)) {
      if (state.castQueue && state.castQueue.id === marker.queueId) queue = state.castQueue;
      else if (state.displayedIsQueue && displayed && displayed.id === marker.queueId) queue = displayed;
      index = marker.index;
    }
  } else if (!session && $("audio").getAttribute("src")) {
    queue = state.localQueueSnapshot;
    index = state.localPlayingIndex;
  }
  let highlighted = -1;
  if (displayed && queue && index >= 0 && index < queue.videos.length) {
    if (state.displayedIsQueue && displayed.id === queue.id) {
      highlighted = index;
    } else if (!state.displayedIsQueue && displayed.id === queue.playlist_id) {
      const current = queue.videos[index];
      const matches = video => video.name === current.name && video.link === current.link;
      const occurrence = queue.videos.slice(0, index + 1).filter(matches).length;
      let found = 0;
      highlighted = displayed.videos.findIndex(video => matches(video) && ++found === occurrence);
    }
  }
  $("tracks").querySelectorAll(".track-button").forEach((button, i) => {
    if (i === highlighted && !button.hasAttribute("aria-current")) button.setAttribute("aria-current", "true");
    else if (i !== highlighted && button.hasAttribute("aria-current")) button.removeAttribute("aria-current");
  });
}
function renderPlaylists() {
  const container = $("playlists");
  container.replaceChildren();
  if (!state.playlists.length) {
    container.textContent = "No playlists found. Create one with New.";
    return;
  }
  state.playlists.forEach(playlist => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "playlist-button";
    button.textContent = playlist.name;
    if (playlist.id === state.selectedPlaylistId) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      state.selectedPlaylistId = playlist.id;
      renderPlaylists();
      showTracks(playlist);
      setBusy(state.busy);
    });
    container.append(button);
  });
}
async function refreshPlaylists(auth = state.auth, signal) {
  const result = await api("/playlists", { auth, signal });
  if (!result || !Array.isArray(result.playlists) || !result.playlists.every(p => typeof p.id === "string" && Array.isArray(p.videos))) {
    throw new ApiError("The server returned an invalid playlist list.");
  }
  return result.playlists;
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-button").disabled = true;
  try {
    const base = new URL($("server").value.trim());
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new ApiError("Enter an HTTP or HTTPS server URL without credentials, query, or fragment.");
    }
    const username = $("username").value;
    if (!username) throw new ApiError("Enter a username.");
    if (username.includes(":")) throw new ApiError("A Basic authentication username cannot contain a colon.");
    const bytes = new TextEncoder().encode(username + ":" + $("password").value);
    const header = "Basic " + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
    const auth = { base: base.href.replace(/\/+$/, ""), header };
    const playlists = await refreshPlaylists(auth);
    state.auth = auth;
    state.playlists = playlists;
    $("password").value = "";
    $("login-panel").hidden = true;
    $("library").hidden = !$("settings-panel").hidden;
    $("signout").hidden = false;
    renderPlaylists();
    const unsaved = [];
    try { localStorage.setItem(serverUrlKey, auth.base); }
    catch { unsaved.push("server URL"); }
    try { localStorage.setItem(usernameKey, username); }
    catch { unsaved.push("username"); }
    message(unsaved.length ? `Connected, but the ${unsaved.join(" and ")} could not be saved in browser storage.` :
      "Connected. Choose a playlist and output.");
  } catch (error) { reportError(error); }
  finally { $("login-button").disabled = false; }
});
$("signout").addEventListener("click", () => signOut());
function openPlaylistDialog(playlist = null) {
  if (!state.auth) return;
  state.editingPlaylistId = playlist ? playlist.id : null;
  $("playlist-form").reset();
  $("playlist-dialog-title").textContent = playlist ? "Edit playlist" : "New playlist";
  $("playlist-name").value = playlist ? playlist.name : "";
  $("playlist-delete").hidden = !playlist;
  $("playlist-error").hidden = true;
  $("playlist-dialog").showModal();
  $("playlist-name").focus();
}
$("new-playlist").addEventListener("click", () => openPlaylistDialog());
$("edit-playlist").addEventListener("click", () => {
  const playlist = state.playlists.find(item => item.id === state.selectedPlaylistId);
  if (playlist) openPlaylistDialog(playlist);
});
$("playlist-cancel").addEventListener("click", () => $("playlist-dialog").close());
$("playlist-dialog").addEventListener("cancel", event => {
  if (state.playlistController) event.preventDefault();
});
function syncSelectedPlaylist() {
  const selected = state.playlists.find(item => item.id === state.selectedPlaylistId);
  if (!selected) state.selectedPlaylistId = null;
  renderPlaylists();
  if (!state.displayedIsQueue) showTracks(selected || null);
}
async function changePlaylist(action, name) {
  if (state.playlistController || !state.auth) return;
  const auth = state.auth;
  const playlistId = state.editingPlaylistId;
  const controller = new AbortController();
  state.playlistController = controller;
  $("playlist-save").disabled = true;
  $("playlist-cancel").disabled = true;
  $("playlist-delete").disabled = true;
  $("playlist-error").hidden = true;
  setBusy(state.busy);
  try {
    const path = action === "create" ? "/playlists" : `/playlists/${encodeURIComponent(playlistId)}`;
    const method = action === "create" ? "POST" : action === "rename" ? "PATCH" : "DELETE";
    const result = await api(path, { method, body: action === "delete" ? undefined : { name }, auth, signal: controller.signal });
    if (state.auth !== auth || state.playlistController !== controller) return;
    if (action === "delete") {
      if (result !== null) throw new ApiError("The server returned an invalid response.", 0, true);
      state.playlists = state.playlists.filter(item => item.id !== playlistId);
      syncSelectedPlaylist();
    } else {
      const playlist = result && result.playlist;
      if (!playlist || typeof playlist.id !== "string" || !playlist.id.trim() ||
          typeof playlist.name !== "string" || !playlist.name.trim() || !Array.isArray(playlist.videos) ||
          (action === "create" && (playlist.videos.length !== 0 || state.playlists.some(item => item.id === playlist.id))) ||
          (action === "rename" && playlist.id !== playlistId)) {
        throw new ApiError("The server returned an invalid playlist.", 0, true);
      }
      if (action === "create") {
        state.playlists.push(playlist);
        state.selectedPlaylistId = playlist.id;
        renderPlaylists();
        showTracks(playlist);
      } else {
        state.playlists = state.playlists.map(item => item.id === playlistId ? playlist : item);
        syncSelectedPlaylist();
      }
    }
    setBusy(state.busy);
    $("playlist-dialog").close();
    message(action === "create" ? "Playlist created." : action === "rename" ? "Playlist renamed." : "Playlist deleted.");
  } catch (error) {
    if (state.auth !== auth || state.playlistController !== controller) return;
    if (error.status === 401) {
      reportError(error);
    } else if (error.uncertain || error.status >= 500) {
      $("playlist-dialog").close();
      try {
        const playlists = await refreshPlaylists(auth, controller.signal);
        if (state.auth !== auth || state.playlistController !== controller) return;
        state.playlists = playlists;
        syncSelectedPlaylist();
        message(`Playlist ${action === "create" ? "creation" : action === "rename" ? "rename" : "deletion"} outcome is uncertain. Check the playlist list before retrying.`);
      } catch (refreshError) {
        if (state.auth !== auth || state.playlistController !== controller) return;
        if (refreshError.status === 401) reportError(refreshError);
        else message("Playlist change outcome is uncertain. Reconnect and check your playlists before retrying.");
      }
    } else {
      $("playlist-error").textContent = error.message || "Could not change the playlist.";
      $("playlist-error").hidden = false;
    }
  } finally {
    if (state.playlistController === controller) {
      state.playlistController = null;
      $("playlist-save").disabled = false;
      $("playlist-cancel").disabled = false;
      $("playlist-delete").disabled = false;
      setBusy(state.busy);
    }
  }
}
$("playlist-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("playlist-name").value.trim();
  if (!name) {
    $("playlist-error").textContent = "Enter a playlist name.";
    $("playlist-error").hidden = false;
    $("playlist-name").focus();
    return;
  }
  changePlaylist(state.editingPlaylistId === null ? "create" : "rename", name);
});
$("playlist-delete").addEventListener("click", () => {
  if (!state.playlistController && state.editingPlaylistId !== null &&
      window.confirm("Delete this playlist? This cannot be undone.")) changePlaylist("delete");
});
$("add-song").addEventListener("click", () => {
  if (!state.auth || !state.selectedPlaylistId || state.playlistController) return;
  $("song-form").reset();
  $("song-error").hidden = true;
  $("song-dialog").showModal();
  $("song-url").focus();
});
$("song-cancel").addEventListener("click", () => $("song-dialog").close());
$("song-dialog").addEventListener("cancel", event => {
  if (state.playlistController) event.preventDefault();
});
$("song-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.playlistController || !state.auth || !state.selectedPlaylistId) return;
  const url = $("song-url").value.trim();
  if (!url) {
    $("song-error").textContent = "Enter a YouTube video URL.";
    $("song-error").hidden = false;
    return;
  }
  const auth = state.auth;
  const playlistId = state.selectedPlaylistId;
  const controller = new AbortController();
  state.playlistController = controller;
  $("song-save").disabled = true;
  $("song-cancel").disabled = true;
  $("song-error").hidden = true;
  setBusy(state.busy);
  try {
    const result = await api(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: "POST", body: { url }, auth, signal: controller.signal
    });
    if (state.auth !== auth || state.playlistController !== controller) return;
    const playlist = result && result.playlist;
    if (!playlist || playlist.id !== playlistId || typeof playlist.name !== "string" ||
        !Array.isArray(playlist.videos) || !playlist.videos.length ||
        !playlist.videos[playlist.videos.length - 1] ||
        playlist.videos[playlist.videos.length - 1].link !== url ||
        typeof playlist.videos[playlist.videos.length - 1].name !== "string" ||
        !playlist.videos[playlist.videos.length - 1].name.trim()) {
      throw new ApiError("The server returned an invalid playlist.", 0, true);
    }
    state.playlists = state.playlists.map(item => item.id === playlistId ? playlist : item);
    syncSelectedPlaylist();
    $("song-dialog").close();
    message("");
  } catch (error) {
    if (state.auth !== auth || state.playlistController !== controller) return;
    if (error.status === 401) {
      reportError(error);
    } else if (error.uncertain || error.status >= 500) {
      $("song-dialog").close();
      try {
        const playlists = await refreshPlaylists(auth, controller.signal);
        if (state.auth !== auth || state.playlistController !== controller) return;
        state.playlists = playlists;
        syncSelectedPlaylist();
        message("Adding the song may still complete. Check the playlist again before retrying.");
      } catch (refreshError) {
        if (state.auth !== auth || state.playlistController !== controller) return;
        if (refreshError.status === 401) reportError(refreshError);
        else message("Adding the song may still complete. Reconnect and check the playlist before retrying.");
      }
    } else {
      $("song-error").textContent = error.status === 400 ? "Enter a valid HTTPS YouTube video URL." :
        error.status === 422 ? "Could not retrieve the YouTube video title. Check that the video is available and try again." :
        error.status === 409 ? "This playlist already has 5,000 songs." :
        error.message || "Could not add the song.";
      $("song-error").hidden = false;
    }
  } finally {
    if (state.playlistController === controller) {
      state.playlistController = null;
      $("song-save").disabled = false;
      $("song-cancel").disabled = false;
      setBusy(state.busy);
    }
  }
});
function openSongEditor(playlist, index) {
  if (!state.auth || state.playlistController || state.busy || state.castLoading) return;
  const videos = playlist.videos.map(video => ({name: video.name, link: video.link}));
  state.editingSong = {playlistId: playlist.id, index, videos};
  $("edit-song-form").reset();
  $("edit-song-name").textContent = videos[index].name;
  $("edit-song-url").value = videos[index].link;
  $("edit-song-error").hidden = true;
  $("edit-song-dialog").showModal();
  $("edit-song-url").focus();
}
$("edit-song-cancel").addEventListener("click", () => $("edit-song-dialog").close());
$("edit-song-dialog").addEventListener("close", () => {
  if (!$("edit-song-dialog").open) state.editingSong = null;
});
$("edit-song-dialog").addEventListener("cancel", event => {
  if (state.playlistController) event.preventDefault();
});
$("edit-song-form").addEventListener("submit", event => {
  event.preventDefault();
  const url = $("edit-song-url").value.trim();
  if (!url) {
    $("edit-song-error").textContent = "Enter a YouTube video URL.";
    $("edit-song-error").hidden = false;
    return;
  }
  changeSong("replace", url);
});
$("edit-song-delete").addEventListener("click", () => {
  const song = state.editingSong;
  if (song && !state.playlistController && window.confirm(`Remove "${song.videos[song.index].name}" from this playlist?`)) {
    changeSong("delete");
  }
});
async function changeSong(action, url) {
  if (!state.auth || !state.editingSong || state.playlistController || state.busy || state.castLoading) return;
  const {playlistId, index, videos} = state.editingSong;
  const auth = state.auth;
  const controller = new AbortController();
  const expected = action === "delete" ? videos.filter((_, position) => position !== index) : videos;
  state.playlistController = controller;
  $("edit-song-save").disabled = true;
  $("edit-song-cancel").disabled = true;
  $("edit-song-delete").disabled = true;
  $("edit-song-error").hidden = true;
  setBusy(state.busy);
  try {
    const result = await api(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: action === "delete" ? "DELETE" : "PATCH",
      body: action === "delete" ? {index, videos} : {index, videos, url},
      auth, signal: controller.signal
    });
    if (state.auth !== auth || state.playlistController !== controller) return;
    const updated = result && result.playlist;
    if (!updated || updated.id !== playlistId || typeof updated.name !== "string" ||
        !Array.isArray(updated.videos) || updated.videos.length !== expected.length ||
        !updated.videos.every((video, position) => video && (
          action === "replace" && position === index
            ? video.link === url && typeof video.name === "string" && !!video.name.trim()
            : video.name === expected[position].name && video.link === expected[position].link))) {
      throw new ApiError("The server returned an invalid playlist.", 0, true);
    }
    state.playlists = state.playlists.map(item => item.id === playlistId ? updated : item);
    syncSelectedPlaylist();
    $("edit-song-dialog").close();
    message(`Song ${action === "delete" ? "removed" : "updated"}. Existing playback queues are unchanged.`);
  } catch (error) {
    if (state.auth !== auth || state.playlistController !== controller) return;
    if (error.status === 401) {
      reportError(error);
    } else if (error.status === 409 || error.status === 404 || error.uncertain || error.status >= 500) {
      $("edit-song-dialog").close();
      try {
        const playlists = await refreshPlaylists(auth, controller.signal);
        if (state.auth !== auth || state.playlistController !== controller) return;
        state.playlists = playlists;
        syncSelectedPlaylist();
        message(error.status === 409 ? "The playlist changed. Review it before editing a song." :
          error.status === 404 ? "The playlist is no longer available." :
          `${action === "delete" ? "Removing" : "Updating"} the song may still complete. Check the playlist again before retrying.`);
      } catch (refreshError) {
        if (state.auth !== auth || state.playlistController !== controller) return;
        if (refreshError.status === 401) reportError(refreshError);
        else message("Could not refresh the playlist. Reconnect and check it before retrying.");
      }
    } else {
      $("edit-song-error").textContent = action === "replace" && error.status === 400 ? "Enter a valid HTTPS YouTube video URL." :
        action === "replace" && error.status === 422 ? "Could not retrieve the YouTube video title. Check that the video is available and try again." :
        error.message || "Could not change the song.";
      $("edit-song-error").hidden = false;
    }
  } finally {
    if (state.playlistController === controller) {
      state.playlistController = null;
      $("edit-song-save").disabled = false;
      $("edit-song-cancel").disabled = false;
      $("edit-song-delete").disabled = false;
      setBusy(state.busy);
    }
  }
}
async function resolveTrack(video, signal) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await api("/resolve", { method: "POST", body: { url: video.link }, signal });
      const audio = result && result.audio;
      if (!audio || typeof audio.title !== "string" || !["audio/mp4", "audio/webm"].includes(audio.content_type)) throw new ApiError("Invalid audio response.");
      let url;
      try { url = new URL(audio.url); } catch { throw new ApiError("Invalid audio URL returned by server."); }
      if (url.protocol !== "https:" || url.username || url.password) throw new ApiError("The server returned an unsafe audio URL.");
      return audio;
    } catch (error) {
      if (error.name === "AbortError" || error.status === 401) throw error;
      lastError = error;
    }
  }
  log(`Skipped “${video.name}” after 3 resolution attempts: ${lastError.message}`);
  return null;
}
function castQueueItems(queue, token, start, end) {
  const items = [];
  for (let i = start; i < end; i++) {
    const url = new URL(state.auth.base + `/api/v1/cast-stream/${i}`);
    url.searchParams.set("token", token);
    const media = new chrome.cast.media.MediaInfo(url.href, "audio/mp4");
    media.customData = { bragiBrowser: { queueId: queue.id, index: i } };
    const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
    metadata.title = queue.videos[i].name;
    const thumbnail = trackArtwork(queue.videos[i]);
    if (thumbnail) metadata.images = [new chrome.cast.Image(thumbnail)];
    media.metadata = metadata;
    const item = new chrome.cast.media.QueueItem(media);
    item.autoplay = true;
    items.push(item);
  }
  return items;
}
async function insertCastItems(media, items, before) {
  const request = new chrome.cast.media.QueueInsertItemsRequest(items);
  if (before != null) request.insertBefore = before;
  await new Promise((resolve, reject) => media.queueInsertItems(request, resolve, reject));
}
function waitForCastMediaSession(session, sessionVersion, generation, signal, queueId, itemIndex) {
  return new Promise((resolve, reject) => {
    const eventType = cast.framework.SessionEventType.MEDIA_SESSION;
    let settled = false;
    let timeout;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      session.removeEventListener(eventType, onMediaSession);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new DOMException("Cancelled", "AbortError"));
    const onMediaSession = () => {
      if (settled) return;
      if (signal.aborted || generation !== state.generation) {
        fail(new DOMException("Cancelled", "AbortError"));
        return;
      }
      if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== sessionVersion) {
        fail(new ApiError("The Cast session changed during loading; check the receiver before retrying."));
        return;
      }
      const media = session.getMediaSession();
      const currentItem = media && media.media && media.media.customData && media.media.customData.bragiBrowser;
      if (media && media.currentItemId != null && currentItem &&
          currentItem.queueId === queueId && currentItem.index === itemIndex) {
        settled = true;
        cleanup();
        resolve(media);
      }
    };
    session.addEventListener(eventType, onMediaSession);
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      onMediaSession();
      if (!settled) {
        fail(new ApiError("Playback started, but the receiver did not report its queue. Check it before retrying."));
      }
    }, 10000);
    onMediaSession();
  });
}
async function startPlayback(playlistId = null, selection = null) {
  if (state.busy || state.castLoading || !state.auth) return;
  const session = state.castContext && state.castContext.getCurrentSession();
  const output = session ? "cast" : "local";
  if (output === "local") prepareVisualizer();
  const castSessionVersion = state.castSessionVersion;
  cancelPreparation();
  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  state.preparingOutput = output;
  setBusy(true);
  try {
    let queue;
    if (playlistId !== null) {
      message("Creating the shared server queue…");
      try {
        queue = requireQueue(await api("/queue", { method: "POST", body: { playlist_id: playlistId, shuffle: $("auto-shuffle").checked }, signal: controller.signal }));
      } catch (error) {
        if (error.uncertain) {
          try {
            const current = requireQueue(await api("/queue", { signal: controller.signal }));
            $("queue-status").textContent = `Current server queue: ${current.name} (${current.videos.length} tracks). It may or may not be the requested queue.`;
          } catch (checkError) {
            if (checkError.status === 401 || checkError.name === "AbortError") throw checkError;
            $("queue-status").textContent = "Could not determine the current server queue.";
          }
          throw new ApiError("Queue creation outcome is uncertain. Check the queue status before retrying.");
        }
        throw error;
      }
    } else {
      queue = requireQueue(await api("/queue", { signal: controller.signal }));
    }
    if (generation !== state.generation) return;
    if (!queue.videos.length) throw new ApiError("The current queue has no tracks.");
    let startIndex = 0;
    if (selection && playlistId === null) {
      if (queue.id !== selection.queueId || selection.index >= queue.videos.length) {
        throw new ApiError("The server queue changed. Select a playlist to create a new queue.");
      }
      startIndex = selection.index;
    } else if (selection) {
      let occurrence = 0;
      startIndex = queue.videos.findIndex(video => {
        if (video.name !== selection.video.name || video.link !== selection.video.link) return false;
        return ++occurrence === selection.occurrence;
      });
      if (startIndex < 0) throw new ApiError("The selected track is no longer in the playlist. Refresh and try again.");
    }
    $("queue-status").textContent = `Server queue: ${queue.name} (${queue.videos.length} tracks${queue.shuffled ? ", shuffled" : ""}).`;
    showTracks(queue, true);
    if (output === "local") {
      stopLocal();
      state.localQueue = queue.videos;
      state.localQueueSnapshot = queue;
      state.localIndex = startIndex - 1;
      await nextLocal(generation, controller.signal);
    } else {
      if (state.castContext.getCurrentSession() !== session) throw new ApiError("The Cast session changed. Reconnect and try again.");
      if (session.getMediaSession() && !window.confirm("The receiver already has media. Replace its current queue?")) {
        message("Receiver queue was not changed.");
        return;
      }
      let prepared;
      try {
        prepared = await api("/cast-queue", { method: "POST", body: { queue_id: queue.id }, signal: controller.signal });
      } catch (error) {
        if (error.status === 404) throw new ApiError("BragiServer must be updated for on-demand Cast playback.");
        throw error;
      }
      if (generation !== state.generation) return;
      if (prepared && !Object.hasOwn(prepared, "batch_size")) {
        throw new ApiError("BragiServer must be updated for configurable Cast batches.");
      }
      if (!prepared || typeof prepared.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(prepared.token) ||
          !Number.isInteger(prepared.batch_size) || prepared.batch_size < 1 || prepared.batch_size > 5000) {
        throw new ApiError("The server returned an invalid Cast queue.");
      }
      if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== castSessionVersion) {
        throw new ApiError("The Cast session changed. Reconnect and try again.");
      }
      const data = new chrome.cast.media.QueueData();
      data.name = queue.name;
      data.repeatMode = chrome.cast.media.RepeatMode.REPEAT_OFF;
      data.items = castQueueItems(queue, prepared.token, startIndex, startIndex + 1);
      data.startIndex = 0;
      data.startTime = 0;
      const request = new chrome.cast.media.LoadRequest(data.items[0].media);
      request.queueData = data;
      request.autoplay = true;
      if (new TextEncoder().encode(JSON.stringify(request)).length > 32000) {
        throw new ApiError("The selected track is too large for the Cast queue.");
      }
      state.castLoading = true;
      setBusy(true);
      message("Sending queue to the receiver; this request cannot be cancelled.");
      try { await session.loadMedia(request); }
      catch { throw new ApiError("The receiver did not confirm the load. Check its status before trying again."); }
      finally { state.castLoading = false; }
      if (generation !== state.generation) return;
      if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== castSessionVersion) {
        throw new ApiError("The Cast session changed during loading; check the receiver before retrying.");
      }
      state.castQueue = queue;
      stopLocal();
      updateCast();
      const media = await waitForCastMediaSession(
        session, castSessionVersion, generation, controller.signal, queue.id, startIndex,
      );
      const firstId = media.currentItemId;
      const checkSession = () => {
        if (state.castContext.getCurrentSession() !== session || state.castSessionVersion !== castSessionVersion ||
            session.getMediaSession() !== media) {
          throw new ApiError("The Cast session changed while sending the queue. Check the receiver before retrying.");
        }
      };
      const insert = async (start, end, before) => {
        checkSession();
        const items = castQueueItems(queue, prepared.token, start, end);
        if (new TextEncoder().encode(JSON.stringify(items)).length > 32000) {
          if (end - start === 1) throw new ApiError("A track is too large for the Cast queue. Playback may already have started.");
          const middle = Math.floor((start + end) / 2);
          await insert(start, middle, before);
          await insert(middle, end, before);
          return;
        }
        try { await insertCastItems(media, items, before); }
        catch { throw new ApiError("The receiver did not confirm the entire queue. Check its queue before retrying."); }
        checkSession();
      };
      state.castLoading = true;
      setBusy(true);
      let sent = 1;
      try {
        for (let start = startIndex + 1; start < queue.videos.length; start += prepared.batch_size) {
          const end = Math.min(start + prepared.batch_size, queue.videos.length);
          await insert(start, end, null);
          sent += end - start;
          message(`Sending queue to the receiver: ${sent} of ${queue.videos.length} songs.`);
        }
        for (let start = 0; start < startIndex; start += prepared.batch_size) {
          const end = Math.min(start + prepared.batch_size, startIndex);
          await insert(start, end, firstId);
          sent += end - start;
          message(`Sending queue to the receiver: ${sent} of ${queue.videos.length} songs.`);
        }
      } finally { state.castLoading = false; }
      message(`Sent ${queue.videos.length} tracks to the receiver. Cast links expire in 7 days or when BragiServer restarts.`);
    }
  } catch (error) {
    if (generation === state.generation) reportError(error);
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.preparingOutput = null;
    }
    if (generation === state.generation) setBusy(false);
    else if (!state.castLoading) setBusy(state.busy);
  }
}
async function nextLocal(generation, signal, direction = 1) {
  const originalIndex = state.localIndex;
  while (state.localIndex + direction >= 0 && state.localIndex + direction < state.localQueue.length) {
    state.localIndex += direction;
    const video = state.localQueue[state.localIndex];
    message(`Resolving local track ${state.localIndex + 1} of ${state.localQueue.length}…`);
    const audio = await resolveTrack(video, signal);
    if (generation !== state.generation) return;
    if (!audio) continue;
    const wantsVisualizer = $("visualizer-mode").value !== "off" && !visualizer.failure && !!visualizer.context;
    const proxyUrl = wantsVisualizer ? await prepareAudioProxy(audio.url, signal) : null;
    if (generation !== state.generation) return;
    const access = $("visualizer-mode").value === "off" || !wantsVisualizer ? "unchecked" : proxyUrl ? "allowed" : "blocked";
    stopVisualizer();
    state.visualizerAccess = access;
    state.localHasPlayed = false;
    state.localDirectUrl = audio.url;
    if (access === "allowed") $("audio").crossOrigin = "anonymous";
    else $("audio").removeAttribute("crossorigin");
    $("audio").src = access === "allowed" ? proxyUrl : audio.url;
    state.localPlayingIndex = state.localIndex;
    state.localTitle = audio.title;
    state.localArtwork = trackArtwork(video);
    updatePlayer();
    $("queue-status").textContent = `Local playback: ${audio.title} (${state.localIndex + 1} of ${state.localQueue.length}).`;
    state.localStarting = true;
    try {
      await $("audio").play();
      if (generation === state.generation && !(access === "allowed" && state.visualizerAccess === "blocked")) message("Playing locally in this browser.");
      return;
    } catch {
      if (generation !== state.generation || (access === "allowed" && state.visualizerAccess === "blocked")) return;
      log(`Could not start “${video.name}”. Use Play to retry, or choose Next.`);
      message("Browser playback was blocked or failed. Use Play to retry, or choose Next.");
      return;
    } finally {
      if (generation === state.generation) state.localStarting = false;
    }
  }
  if (direction < 0) {
    state.localIndex = originalIndex;
    message("No earlier track could be resolved.");
    return;
  }
  stopLocal();
  message("Local queue finished or no remaining tracks could be resolved.");
}
async function advanceLocal(direction = 1) {
  if (state.busy || !state.localQueue.length) return;
  prepareVisualizer();
  cancelPreparation();
  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  state.preparingOutput = "local";
  setBusy(true);
  try { await nextLocal(generation, controller.signal, direction); }
  catch (error) { if (generation === state.generation) reportError(error); }
  finally {
    if (state.controller === controller) {
      state.controller = null;
      state.preparingOutput = null;
    }
    if (generation === state.generation) setBusy(false);
  }
}
$("play-selected").addEventListener("click", () => {
  if (state.selectedPlaylistId !== null) startPlayback(state.selectedPlaylistId);
});
$("audio").addEventListener("ended", () => advanceLocal());
$("audio").addEventListener("playing", () => { state.localHasPlayed = true; syncVisualizer(); });
$("audio").addEventListener("error", () => {
  if (!state.localQueue.length || !$("audio").getAttribute("src") || !$("audio").error) return;
  const generation = state.generation;
  const index = state.localIndex;
  const audio = $("audio");
  if (state.visualizerAccess === "allowed") {
    const url = state.localDirectUrl;
    const position = audio.currentTime;
    const shouldPlay = !state.localHasPlayed || !audio.paused;
    state.visualizerAccess = "blocked";
    stopVisualizer();
    audio.removeAttribute("crossorigin");
    if (Number.isFinite(position) && position > 0) {
      audio.addEventListener("loadedmetadata", () => {
        if (generation !== state.generation || index !== state.localIndex) return;
        try { audio.currentTime = position; }
        catch { message("Could not restore the browser playback position after visualizer fallback."); }
      }, { once: true });
    }
    audio.src = url;
    log("Audio proxy playback failed; retrying the direct stream without audio analysis.");
    message("Audio proxy playback failed; retrying browser playback normally.");
    updatePlayer();
    if (shouldPlay) audio.play().catch(() => {
      if (generation === state.generation && index === state.localIndex) {
        message("Browser playback could not restart. Use Play to retry.");
      }
    });
    return;
  }
  setTimeout(() => {
    if (generation !== state.generation || index !== state.localIndex || !state.localQueue.length) return;
    log(`Playback failed for “${state.localQueue[index].name}”; skipping.`);
    advanceLocal();
  }, 0);
});

function updateCast() {
  const session = state.castContext && state.castContext.getCurrentSession();
  if (session !== state.castSession) {
    state.castSessionVersion++;
    state.castQueue = null;
    if (state.busy && !state.castLoading) {
      cancelPreparation();
      message("Cast session changed; preparation cancelled.");
    } else if (state.castLoading) {
      message("Cast session changed during loading; check the receiver before retrying.");
    }
    if (state.castSession) {
      state.castSession.removeEventListener(cast.framework.SessionEventType.MEDIA_SESSION, updateCast);
      state.castSession.removeEventListener(cast.framework.SessionEventType.VOLUME_CHANGED, updateCast);
    }
    state.castSession = session;
    if (session) {
      session.addEventListener(cast.framework.SessionEventType.MEDIA_SESSION, updateCast);
      session.addEventListener(cast.framework.SessionEventType.VOLUME_CHANGED, updateCast);
    }
  }
  const media = session && session.getMediaSession();
  if (media !== state.castMedia) {
    if (state.castMedia) state.castMedia.removeUpdateListener(updateCast);
    state.castMedia = media;
    if (media) media.addUpdateListener(updateCast);
  }
  const device = session && session.getCastDevice();
  $("cast-status").textContent = session ? `Connected: ${device && device.friendlyName || "Cast receiver"}` : "No Cast receiver connected";
  updatePlayer();
}
window.__onGCastApiAvailable = function(available) {
  if (!available) { $("cast-status").textContent = "Cast unavailable in this browser."; return; }
  try {
    state.castContext = cast.framework.CastContext.getInstance();
    state.castContext.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
    state.castContext.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, updateCast);
    updateCast();
  } catch { $("cast-status").textContent = "Cast could not initialize."; }
};
window.castSdkLoadFailed = function() { $("cast-status").textContent = "Cast SDK could not be downloaded."; };
async function castCommand(command) {
  const session = state.castContext && state.castContext.getCurrentSession();
  const media = session && session.getMediaSession();
  if (!media) { updateCast(); return; }
  try {
    await new Promise((resolve, reject) => {
      if (command === "stop") media.stop(new chrome.cast.media.StopRequest(), resolve, reject);
      else if (command === "next") media.queueNext(resolve, reject);
      else if (command === "previous") media.queuePrev(resolve, reject);
      else if (["PLAYING", "BUFFERING"].includes(media.playerState)) media.pause(new chrome.cast.media.PauseRequest(), resolve, reject);
      else media.play(new chrome.cast.media.PlayRequest(), resolve, reject);
    });
    message("Playback command sent to receiver.");
  } catch { message("The receiver did not confirm the playback command."); }
}

function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function safeArtworkUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function trackArtwork(video) {
  const thumbnail = safeArtworkUrl(video.thumbnail_url);
  if (video.thumbnail_url != null && !thumbnail) log(`Invalid artwork URL for “${video.name}”; showing the placeholder.`);
  return thumbnail;
}

function artworkAccent(image) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const hues = Array.from({ length: 24 }, () => ({ weight: 0, red: 0, green: 0, blue: 0 }));
  let visible = false;
  for (let i = 0; i < pixels.length; i += 4) {
    const [red, green, blue, alpha] = pixels.subarray(i, i + 4);
    if (alpha < 32) continue;
    visible = true;
    const max = Math.max(red, green, blue), min = Math.min(red, green, blue), chroma = max - min;
    if (chroma < 20 || max < 25) continue;
    let hue = max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
    const weight = (alpha / 255) * (0.3 + 0.7 * chroma / 255);
    const bucket = hues[Math.floor(hue / 15)];
    bucket.weight += weight;
    bucket.red += red * weight;
    bucket.green += green * weight;
    bucket.blue += blue * weight;
  }
  if (!visible) throw new Error("Artwork has no visible pixels.");
  const best = hues.reduce((a, b) => b.weight > a.weight ? b : a);
  if (!best.weight) return "hsl(0 0% 80%)";
  const red = best.red / best.weight, green = best.green / best.weight, blue = best.blue / best.weight;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), chroma = max - min;
  let hue = max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  hue = Math.round((hue * 60 + 360) % 360);
  return `hsl(${hue} 55% 80%)`;
}

function updateAccent(url, version) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.referrerPolicy = "no-referrer";
  image.onload = () => {
    if (version !== state.artworkVersion) return;
    try { document.documentElement.style.setProperty("--accent", artworkAccent(image)); }
    catch { log("Could not extract an accent from the artwork; using the default color."); }
  };
  image.onerror = () => {
    if (version === state.artworkVersion) log("Could not sample artwork for an accent; using the default color.");
  };
  image.src = url;
}

function updateArtwork(source) {
  if (source === state.artworkSource) return;
  state.artworkSource = source;
  state.artworkVersion++;
  document.documentElement.style.removeProperty("--accent");
  const image = $("player-artwork");
  image.hidden = true;
  $("artwork-placeholder").hidden = false;
  image.removeAttribute("src");
  $("player-background").hidden = true;
  $("player-background").removeAttribute("src");
  if (source == null) return;
  const url = safeArtworkUrl(source);
  if (!url) {
    log("Invalid receiver artwork URL; showing the placeholder.");
    return;
  }
  image.src = url;
}

$("player-artwork").addEventListener("load", () => {
  if (!$("player-artwork").hasAttribute("src")) return;
  $("player-artwork").hidden = false;
  $("artwork-placeholder").hidden = true;
  $("player-background").src = $("player-artwork").src;
  updateAccent($("player-artwork").src, state.artworkVersion);
});
$("player-artwork").addEventListener("error", () => {
  state.artworkVersion++;
  document.documentElement.style.removeProperty("--accent");
  $("player-artwork").hidden = true;
  $("artwork-placeholder").hidden = false;
  $("player-background").hidden = true;
  $("player-background").removeAttribute("src");
  log("Could not load track artwork; showing the placeholder.");
});
$("player-background").addEventListener("load", () => {
  if ($("player-background").hasAttribute("src")) $("player-background").hidden = false;
});
$("player-background").addEventListener("error", () => {
  $("player-background").hidden = true;
  log("Could not load the player background artwork.");
});

function updatePlayer() {
  const audio = $("audio");
  const session = state.castContext && state.castContext.getCurrentSession();
  const casting = !!session;
  const media = session && session.getMediaSession();
  const hasLocal = !!audio.getAttribute("src") && state.localQueue.length > 0;
  const device = casting && session.getCastDevice();
  $("output-status").textContent = casting ? (device && device.friendlyName || "Chromecast") : "This browser";
  $("stop-browser").hidden = !casting || !hasLocal;
  const hasMedia = casting ? !!media && media.playerState !== "IDLE" : hasLocal;
  updateTrackHighlight();
  $("player-title").textContent = casting
    ? hasMedia && media.media && media.media.metadata && media.media.metadata.title || "No receiver track loaded."
    : hasLocal ? state.localTitle : "No local track loaded.";
  const images = casting && hasMedia && media.media && media.media.metadata && media.media.metadata.images;
  updateArtwork(casting ? (Array.isArray(images) && images[0] && images[0].url || null) : hasLocal ? state.localArtwork : null);
  const target = casting ? media : audio.getAttribute("src");
  const track = casting ? media && media.currentItemId : state.localIndex;
  if (state.seeking && (state.seeking.casting !== casting || state.seeking.target !== target || state.seeking.track !== track)) state.seeking = null;
  if (state.volumeEditing && (state.volumeEditing.casting !== casting || state.volumeEditing.session !== session)) state.volumeEditing = null;
  const playing = hasMedia && (casting ? ["PLAYING", "BUFFERING"].includes(media.playerState) : !audio.paused && !audio.ended);
  $("play-pause").disabled = !hasMedia || state.busy;
  $("play-pause").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("play-pause").title = playing ? "Pause" : "Play";
  $("play-pause-icon").textContent = playing ? "pause" : "play_arrow";
  $("stop").disabled = !hasMedia || state.busy;
  $("previous").disabled = state.busy || !hasMedia || (!casting && state.localIndex <= 0);
  $("next").disabled = state.busy || !hasMedia || (!casting && state.localIndex >= state.localQueue.length - 1);

  const duration = hasMedia ? (casting ? media.media && media.media.duration : audio.duration) : 0;
  const current = hasMedia ? (casting ? media.getEstimatedTime() : audio.currentTime) : 0;
  const canSeek = hasMedia && Number.isFinite(duration) && duration > 0 &&
    (!casting || media.supportsCommand(chrome.cast.media.MediaCommand.SEEK));
  $("seek").disabled = !canSeek || state.busy;
  $("seek").max = String(canSeek ? duration : 0);
  $("seek-duration").textContent = formatTime(duration);
  if (!state.seeking) $("seek").value = String(canSeek && Number.isFinite(current) ? Math.min(duration, Math.max(0, current)) : 0);
  $("seek-current").textContent = formatTime(Number($("seek").value));

  const volume = casting ? session && session.getVolume() : audio.volume;
  const muted = casting ? session.isMute() : audio.muted;
  $("volume").disabled = state.volumePending || (casting && (!session || !Number.isFinite(volume)));
  $("mute").disabled = state.volumePending || typeof muted !== "boolean";
  const muteLabel = typeof muted !== "boolean" ? "Mute unavailable" : muted ? "Unmute" : "Mute";
  $("mute").setAttribute("aria-label", muteLabel);
  $("mute").title = muteLabel;
  $("mute-icon").textContent = muted ? "volume_off" : "volume_up";
  if (!state.volumeEditing && !state.volumePending) $("volume").value = String(Number.isFinite(volume) ? volume : 0);
  $("volume-value").textContent = casting && !Number.isFinite(volume) ? "—" : `${Math.round(Number($("volume").value) * 100)}%`;
  syncVisualizer();
}

["play", "pause", "ended", "emptied", "loadedmetadata", "durationchange", "timeupdate", "volumechange"].forEach(event => {
  $("audio").addEventListener(event, updatePlayer);
});
setInterval(updatePlayer, 1000);
document.addEventListener("visibilitychange", syncVisualizer);

$("play-pause").addEventListener("click", async () => {
  if (state.castContext && state.castContext.getCurrentSession()) return castCommand("toggle");
  const audio = $("audio");
  if (audio.paused || audio.ended) {
    prepareVisualizer();
    try { await audio.play(); }
    catch { message("Browser playback could not start. Try Play again or choose another track."); }
  } else audio.pause();
  updatePlayer();
});
$("stop").addEventListener("click", () => {
  if (state.castContext && state.castContext.getCurrentSession()) return castCommand("stop");
  cancelPreparation();
  stopLocal();
  message("Local playback stopped.");
});
$("next").addEventListener("click", () => {
  if (state.castContext && state.castContext.getCurrentSession()) return castCommand("next");
  return advanceLocal();
});
$("previous").addEventListener("click", () => {
  if (state.castContext && state.castContext.getCurrentSession()) return castCommand("previous");
  return advanceLocal(-1);
});
$("seek").addEventListener("input", () => {
  const session = state.castContext && state.castContext.getCurrentSession();
  const casting = !!session;
  const media = session && session.getMediaSession();
  state.seeking = { casting, target: casting ? media : $("audio").getAttribute("src"), track: casting ? media && media.currentItemId : state.localIndex };
  $("seek-current").textContent = formatTime(Number($("seek").value));
});
$("seek").addEventListener("change", async () => {
  const selection = state.seeking;
  state.seeking = null;
  if (!selection || $("seek").disabled) return updatePlayer();
  const time = Number($("seek").value);
  if (selection.casting) {
    const session = state.castContext && state.castContext.getCurrentSession();
    const media = session && session.getMediaSession();
    if (!media || media !== selection.target || media.currentItemId !== selection.track) return updatePlayer();
    const request = new chrome.cast.media.SeekRequest();
    request.currentTime = time;
    try { await new Promise((resolve, reject) => media.seek(request, resolve, reject)); }
    catch { message("The receiver did not confirm the seek."); }
  } else if (!(state.castContext && state.castContext.getCurrentSession()) && $("audio").getAttribute("src") === selection.target && state.localIndex === selection.track) {
    try { $("audio").currentTime = time; }
    catch { message("Could not seek local playback."); }
  }
  updatePlayer();
});
$("volume").addEventListener("input", () => {
  const session = state.castContext && state.castContext.getCurrentSession();
  const casting = !!session;
  state.volumeEditing = { casting, session };
  $("volume-value").textContent = `${Math.round(Number($("volume").value) * 100)}%`;
  if (!casting) $("audio").volume = Number($("volume").value);
});
$("volume").addEventListener("change", async () => {
  const selection = state.volumeEditing;
  state.volumeEditing = null;
  if (!selection) return updatePlayer();
  if (selection.casting) {
    const session = state.castContext && state.castContext.getCurrentSession();
    if (!session || session !== selection.session) return updatePlayer();
    const volume = Number($("volume").value);
    state.volumePending = true;
    updatePlayer();
    try { await session.setVolume(volume); }
    catch { message("Could not change Chromecast volume."); }
    finally { state.volumePending = false; }
  }
  updatePlayer();
});
$("mute").addEventListener("click", async () => {
  if (state.volumePending) return;
  const session = state.castContext && state.castContext.getCurrentSession();
  if (session) {
    const muted = session.isMute();
    if (typeof muted !== "boolean") return updatePlayer();
    state.volumePending = true;
    updatePlayer();
    try { await session.setMute(!muted); }
    catch { message("Could not change Chromecast mute state."); }
    finally { state.volumePending = false; }
  } else {
    const audio = $("audio");
    audio.muted = !audio.muted;
  }
  updatePlayer();
});
$("stop-browser").addEventListener("click", () => {
  if (state.preparingOutput === "local") cancelPreparation();
  stopLocal();
  message("Browser playback stopped. Receiver playback was not changed.");
});
updatePlayer();
