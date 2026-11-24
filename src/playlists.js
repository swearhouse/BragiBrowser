import { $, message } from "./dom.js";
import { state } from "./state.js";
import { api, ApiError, refreshPlaylists } from "./api.js";
import { configuredServerBase } from "./config.js";
import { reportError, setBusy } from "./shell.js";
import { startPlayback } from "./localPlayback.js";
import { queueNext, getCastMediaSession } from "./cast.js";
import { safeArtworkUrl } from "./artwork.js";

export const userScrollPauseMs = 5000;
let highlightedButton = null;

export function centerCurrentTrack() {
  clearTimeout(state.autoScrollTimer);
  state.autoScrollTimer = null;
  const list = $("tracks");
  const button = list.querySelector('.track-button[aria-current="true"]');
  if (!button || button.parentElement.hidden || !list.getClientRects().length) return;
  const listRect = list.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const offset = buttonRect.top - listRect.top - list.clientTop + list.scrollTop;
  list.scrollTo({
    top: Math.max(0, offset - (list.clientHeight - buttonRect.height) / 2),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}

export function pauseAutoScroll() {
  clearTimeout(state.autoScrollTimer);
  state.autoScrollTimer = setTimeout(centerCurrentTrack, userScrollPauseMs);
}

export function filterTracks() {
  const playlist = state.displayedPlaylist;
  const query = $("track-search").value.trim().toLocaleLowerCase();
  const current = $("tracks").querySelector('.track-button[aria-current="true"]');
  const wasHidden = current && current.parentElement.hidden;
  let matches = 0;
  $("tracks").querySelectorAll("li").forEach(item => {
    item.hidden = !(item.dataset.search || "").includes(query);
    if (!item.hidden) matches++;
  });
  $("tracks-empty").hidden = matches > 0;
  $("tracks-empty").textContent = !playlist ? "Choose a playlist from your library." :
    !playlist.videos.length ? "This playlist has no tracks." : "No songs match your search.";
  if (wasHidden && !current.parentElement.hidden && state.autoScrollTimer === null) centerCurrentTrack();
}

export function showTracks(playlist, isQueue = false) {
  state.displayedPlaylist = playlist;
  state.displayedIsQueue = isQueue;
  $("toggle-track-view").hidden = !state.lastQueue;
  $("toggle-track-view").textContent = isQueue ? "Show saved playlist" : "Show playback queue";
  $("playlist-display-name").textContent = playlist ? playlist.name : "No playlist selected";
  $("playlist-summary").textContent = playlist
    ? ` - (${playlist.videos.length} ${playlist.videos.length === 1 ? "song" : "songs"})${isQueue ? " · server queue" : ""}` : "";
  const list = $("tracks");
  list.replaceChildren();
  highlightedButton = null;
  if (!playlist) {
    filterTracks();
    return;
  }
  const fragment = document.createDocumentFragment();
  playlist.videos.forEach((video, index) => {
    const item = document.createElement("li");
    item.dataset.search = video.name.toLocaleLowerCase();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-button";
    button.dataset.trackNumber = index + 1;
    button.setAttribute("aria-label", `Play ${video.name}, track ${index + 1}`);
    button.disabled = state.busy || state.castLoading;
    if (state.trackThumbs) {
      const thumbUrl = safeArtworkUrl(video.thumbnail_url);
      if (thumbUrl) {
        const img = document.createElement("img");
        img.className = "track-thumb";
        img.src = thumbUrl;
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => { img.hidden = true; });
        button.append(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "track-thumb-placeholder";
        ph.setAttribute("aria-hidden", "true");
        ph.textContent = "♪";
        button.append(ph);
      }
    }
    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = video.name;
    button.append(name);
    item.append(button);
    if (!isQueue) {
      const menu = document.createElement("details");
      menu.className = "track-menu";
      const toggle = document.createElement("summary");
      toggle.className = "icon-button";
      toggle.setAttribute("aria-label", `Actions for ${video.name}, track ${index + 1}`);
      toggle.title = "Song actions";
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "menu";
      toggle.append(icon);
      const actions = document.createElement("div");
      actions.className = "track-menu-actions";
      const addAction = (label, className) => {
        const action = document.createElement("button");
        action.type = "button";
        action.className = className;
        action.textContent = label;
        actions.append(action);
        return action;
      };
      const queue = addAction("Queue", "queue-song");
      queue.disabled = state.busy || state.castLoading;
      addAction("Open in YouTube", "open-song");
      const edit = addAction("Edit", "edit-song");
      const replace = addAction("Replace...", "replace-song");
      const remove = addAction("Delete", "delete-song");
      edit.disabled = replace.disabled = remove.disabled = state.busy || state.castLoading || !!state.playlistController;
      menu.append(toggle, actions);
      item.append(menu);
    }
    fragment.append(item);
  });
  list.append(fragment);
  filterTracks();
  updateTrackHighlight();
}

export function openYouTube(video) {
  let url;
  try { url = new URL(video.link); }
  catch { message("This song has an invalid YouTube URL."); return; }
  if (url.protocol !== "https:" || url.username || url.password ||
      !(url.hostname === "youtu.be" || url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"))) {
    message("This song has an invalid YouTube URL.");
    return;
  }
  const link = document.createElement("a");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
}

export function updateTrackHighlight() {
  const displayed = state.displayedPlaylist;
  const session = state.castContext && state.castContext.getCurrentSession();
  const media = getCastMediaSession(session);
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
    index = state.localQueueOrigins[state.localPlayingIndex];
    if (!Number.isInteger(index)) index = -1;
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
  const next = $("tracks").querySelectorAll(".track-button")[highlighted] || null;
  if (next === highlightedButton) return;
  if (highlightedButton) highlightedButton.removeAttribute("aria-current");
  if (next) next.setAttribute("aria-current", "true");
  highlightedButton = next;
  if (state.autoScrollTimer === null) centerCurrentTrack();
}

export function renderPlaylists() {
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

export function openPlaylistDialog(playlist = null) {
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

function syncSelectedPlaylist() {
  const selected = state.playlists.find(item => item.id === state.selectedPlaylistId);
  if (!selected) state.selectedPlaylistId = null;
  renderPlaylists();
  if (!state.displayedIsQueue) showTracks(selected || null);
}

export async function changePlaylist(action, name) {
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

function songVideos(playlist) {
  return playlist.videos.map(video => ({name: video.name, link: video.link}));
}

export function openSongEditor(playlist, index) {
  if (!state.auth || state.playlistController || state.busy || state.castLoading) return;
  const videos = songVideos(playlist);
  state.editingSong = {playlistId: playlist.id, index, videos};
  $("edit-song-form").reset();
  $("edit-song-name").textContent = videos[index].name;
  $("edit-song-url").value = videos[index].link;
  $("edit-song-error").hidden = true;
  $("edit-song-dialog").showModal();
  $("edit-song-url").focus();
}

function resetReplacePreview() {
  if (state.replacePreviewController) state.replacePreviewController.abort();
  state.replacePreviewController = null;
  const audio = $("replace-song-audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  $("replace-song-preview").hidden = true;
  $("replace-song-preview-title").textContent = "";
}

function clearReplaceResults() {
  $("replace-song-results").replaceChildren();
  $("replace-song-empty").hidden = true;
  $("replace-song-empty").textContent = "";
}

export function closeReplaceSongDialog() {
  resetReplacePreview();
  if (state.replaceSearchController) state.replaceSearchController.abort();
  state.replaceSearchController = null;
  clearReplaceResults();
  $("replace-song-error").hidden = true;
  $("replace-song-error").textContent = "";
  $("replace-song-search").disabled = false;
  state.replaceSong = null;
  if ($("replace-song-dialog").open) $("replace-song-dialog").close();
}

function normalizeSearchInstance(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("HTTPS required");
  return url.origin;
}

async function searchYouTube(query, signal) {
  const instance = normalizeSearchInstance(state.youtubeSearchInstance);
  const url = new URL("/api/v1/search", instance);
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  let response;
  try {
    response = await fetch(url, {signal, headers: {Accept: "application/json"}});
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("Could not reach the YouTube search instance. Check the instance URL and CORS support.");
  }
  if (!response.ok) throw new ApiError(`Search failed (${response.status}). Try a different Invidious instance.`);
  let data;
  try { data = await response.json(); } catch { throw new ApiError("The search instance returned an invalid response."); }
  if (!Array.isArray(data)) throw new ApiError("The search instance returned an invalid response.");
  return data.filter(item => item && item.type === "video" && typeof item.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(item.videoId))
    .slice(0, 10).map(item => ({
      videoId: item.videoId,
      title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled video",
      author: typeof item.author === "string" ? item.author : "",
      url: `https://youtu.be/${item.videoId}`
    }));
}

function renderReplaceResults(results) {
  const list = $("replace-song-results");
  list.replaceChildren();
  if (!results.length) {
    $("replace-song-empty").textContent = "No videos found.";
    $("replace-song-empty").hidden = false;
    return;
  }
  $("replace-song-empty").hidden = true;
  results.forEach(result => {
    const item = document.createElement("li");
    item.className = "replace-result";
    const meta = document.createElement("div");
    meta.className = "replace-result-meta";
    const title = document.createElement("p");
    title.className = "replace-result-title";
    title.textContent = result.title;
    const author = document.createElement("p");
    author.className = "muted replace-result-author";
    author.textContent = result.author || "Unknown channel";
    meta.append(title, author);
    const actions = document.createElement("div");
    actions.className = "replace-result-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "preview-replace-song";
    preview.textContent = "Preview";
    preview.setAttribute("aria-label", `Preview ${result.title}`);
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "primary use-replace-song";
    replace.textContent = "Replace";
    replace.setAttribute("aria-label", `Replace with ${result.title}`);
    replace.disabled = state.busy || state.castLoading || !!state.playlistController;
    actions.append(preview, replace);
    item.append(meta, actions);
    item.dataset.url = result.url;
    item.dataset.title = result.title;
    list.append(item);
  });
}

async function previewReplaceResult(result) {
  if (!state.auth) return;
  resetReplacePreview();
  const controller = new AbortController();
  state.replacePreviewController = controller;
  $("replace-song-error").hidden = true;
  $("replace-song-preview-title").textContent = `Loading preview: ${result.title}`;
  $("replace-song-preview").hidden = false;
  try {
    const resolved = await api("/resolve", {method: "POST", body: {url: result.url}, signal: controller.signal});
    const audioInfo = resolved && resolved.audio;
    if (!audioInfo || typeof audioInfo.url !== "string") throw new ApiError("The server returned an invalid audio response.");
    let src = audioInfo.url;
    if (audioInfo.url.startsWith("https://")) {
      const proxy = await api("/audio-proxy", {method: "POST", body: {url: audioInfo.url}, signal: controller.signal});
      if (!proxy || typeof proxy.proxy_url !== "string") throw new ApiError("The server returned an invalid audio proxy response.");
      src = new URL(proxy.proxy_url, await configuredServerBase() + "/").toString();
    }
    if (controller.signal.aborted || state.replacePreviewController !== controller) return;
    const audio = $("replace-song-audio");
    audio.crossOrigin = "anonymous";
    audio.src = src;
    $("replace-song-preview-title").textContent = `Preview: ${result.title}`;
    await audio.play();
  } catch (error) {
    if (error.name === "AbortError" || state.replacePreviewController !== controller) return;
    $("replace-song-preview").hidden = true;
    $("replace-song-error").textContent = error.message || "Could not preview this video.";
    $("replace-song-error").hidden = false;
  } finally {
    if (state.replacePreviewController === controller) state.replacePreviewController = null;
  }
}

export async function openReplaceSongDialog(playlist, index) {
  if (!state.auth || state.playlistController || state.busy || state.castLoading) return;
  const videos = songVideos(playlist);
  closeReplaceSongDialog();
  state.replaceSong = {playlistId: playlist.id, index, videos, name: videos[index].name};
  $("replace-song-form").reset();
  $("replace-song-name").textContent = `Current song: ${videos[index].name}`;
  $("replace-song-query").value = videos[index].name;
  $("replace-song-dialog").showModal();
  $("replace-song-query").focus();
  await runReplaceSearch();
}

async function runReplaceSearch() {
  if (!state.replaceSong || state.replaceSearchController) return;
  const query = $("replace-song-query").value.trim();
  if (!query) {
    $("replace-song-error").textContent = "Enter a search query.";
    $("replace-song-error").hidden = false;
    return;
  }
  resetReplacePreview();
  clearReplaceResults();
  $("replace-song-error").hidden = true;
  const controller = new AbortController();
  state.replaceSearchController = controller;
  $("replace-song-search").disabled = true;
  $("replace-song-empty").textContent = "Searching...";
  $("replace-song-empty").hidden = false;
  try {
    const results = await searchYouTube(query, controller.signal);
    if (controller.signal.aborted || state.replaceSearchController !== controller) return;
    renderReplaceResults(results);
  } catch (error) {
    if (error.name === "AbortError" || state.replaceSearchController !== controller) return;
    $("replace-song-empty").hidden = true;
    $("replace-song-error").textContent = error.message || "Search failed.";
    $("replace-song-error").hidden = false;
  } finally {
    if (state.replaceSearchController === controller) {
      state.replaceSearchController = null;
      $("replace-song-search").disabled = false;
    }
  }
}

export function deleteSong(playlist, index) {
  if (!state.auth || state.playlistController || state.busy || state.castLoading) return;
  const videos = songVideos(playlist);
  if (!window.confirm(`Remove "${videos[index].name}" from this playlist?`)) return;
  state.editingSong = {playlistId: playlist.id, index, videos};
  changeSong("delete");
}

export async function changeSong(action, url, source = "edit") {
  const target = source === "replace-dialog" ? state.replaceSong : state.editingSong;
  if (!state.auth || !target || state.playlistController || state.busy || state.castLoading) return;
  const {playlistId, index, videos} = target;
  const auth = state.auth;
  const controller = new AbortController();
  const expected = action === "delete" ? videos.filter((_, position) => position !== index) : videos;
  state.playlistController = controller;
  if (source === "replace-dialog") {
    $("replace-song-search").disabled = true;
    $("replace-song-cancel").disabled = true;
    $("replace-song-error").hidden = true;
    document.querySelectorAll(".use-replace-song, .preview-replace-song").forEach(button => { button.disabled = true; });
  } else {
    $("edit-song-save").disabled = true;
    $("edit-song-cancel").disabled = true;
    $("edit-song-delete").disabled = true;
    $("edit-song-error").hidden = true;
  }
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
    if (source === "replace-dialog") closeReplaceSongDialog();
    else $("edit-song-dialog").close();
    message(`Song ${action === "delete" ? "removed" : "updated"}. Existing playback queues are unchanged.`);
  } catch (error) {
    if (state.auth !== auth || state.playlistController !== controller) return;
    if (error.status === 401) {
      reportError(error);
    } else if (error.status === 409 || error.status === 404 || error.uncertain || error.status >= 500) {
      if (source === "replace-dialog") closeReplaceSongDialog();
      else $("edit-song-dialog").close();
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
      const text = action === "replace" && error.status === 400 ? "Enter a valid HTTPS YouTube video URL." :
        action === "replace" && error.status === 422 ? "Could not retrieve the YouTube video title. Check that the video is available and try again." :
        error.message || "Could not change the song.";
      const dialogOpen = source === "replace-dialog" ? $("replace-song-dialog").open : $("edit-song-dialog").open;
      const errorEl = source === "replace-dialog" ? $("replace-song-error") : $("edit-song-error");
      if (dialogOpen) {
        errorEl.textContent = text;
        errorEl.hidden = false;
      } else message(text);
    }
  } finally {
    if (state.playlistController === controller) {
      state.playlistController = null;
      if (source === "replace-dialog") {
        $("replace-song-search").disabled = false;
        $("replace-song-cancel").disabled = false;
        document.querySelectorAll(".use-replace-song, .preview-replace-song").forEach(button => { button.disabled = !!state.playlistController; });
        if (!$("replace-song-dialog").open) state.replaceSong = null;
      } else {
        $("edit-song-save").disabled = false;
        $("edit-song-cancel").disabled = false;
        $("edit-song-delete").disabled = false;
        if (!$("edit-song-dialog").open) state.editingSong = null;
      }
      setBusy(state.busy);
    }
  }
}

export function initPlaylists() {
  ["wheel", "touchmove", "pointerdown", "keydown"].forEach(type => {
    $("tracks").addEventListener(type, pauseAutoScroll, { passive: true });
  });
  $("tracks").addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const list = $("tracks");
    const item = event.target.closest("li");
    if (!item || !list.contains(item)) return;
    const index = Array.prototype.indexOf.call(list.children, item);
    const playlist = state.displayedPlaylist;
    if (!playlist || !playlist.videos[index]) return;
    const video = playlist.videos[index];
    const action = event.target.closest("button");
    const menu = event.target.closest(".track-menu");
    if (action && menu) {
      menu.open = false;
      if (action.classList.contains("queue-song")) return queueNext(video);
      if (action.classList.contains("open-song")) return openYouTube(video);
      if (action.classList.contains("edit-song")) return openSongEditor(playlist, index);
      if (action.classList.contains("replace-song")) return openReplaceSongDialog(playlist, index);
      if (action.classList.contains("delete-song")) return deleteSong(playlist, index);
    }
    if (action && action.classList.contains("track-button")) {
      clearTimeout(state.autoScrollTimer);
      state.autoScrollTimer = null;
      if (state.displayedIsQueue) return startPlayback(null, { queueId: playlist.id, index });
      const occurrence = playlist.videos.slice(0, index + 1).filter(track => track.name === video.name && track.link === video.link).length;
      return startPlayback(playlist.id, { video, occurrence });
    }
    const toggle = event.target.closest(".track-menu > summary");
    if (toggle && !toggle.parentElement.open) {
      document.querySelectorAll(".track-menu[open]").forEach(other => {
        if (other !== toggle.parentElement) other.open = false;
      });
    }
  });
  $("track-search").addEventListener("input", filterTracks);
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element) || !event.target.closest(".track-menu")) {
      document.querySelectorAll(".track-menu[open]").forEach(menu => { menu.open = false; });
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const menu = document.querySelector(".track-menu[open]");
    if (menu) {
      menu.open = false;
      menu.querySelector("summary").focus();
      event.preventDefault();
    }
  });
  $("toggle-track-view").addEventListener("click", () => {
    if (state.displayedIsQueue) {
      showTracks(state.playlists.find(playlist => playlist.id === state.selectedPlaylistId) || null);
    } else if (state.lastQueue) {
      showTracks(state.lastQueue, true);
    }
  });
  $("new-playlist").addEventListener("click", () => openPlaylistDialog());
  $("edit-playlist").addEventListener("click", () => {
    const playlist = state.playlists.find(item => item.id === state.selectedPlaylistId);
    if (playlist) openPlaylistDialog(playlist);
  });
  $("playlist-cancel").addEventListener("click", () => $("playlist-dialog").close());
  $("playlist-dialog").addEventListener("cancel", event => {
    if (state.playlistController) event.preventDefault();
  });
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
  $("replace-song-cancel").addEventListener("click", closeReplaceSongDialog);
  $("replace-song-dialog").addEventListener("close", () => {
    if (!$("replace-song-dialog").open) {
      resetReplacePreview();
      if (state.replaceSearchController) state.replaceSearchController.abort();
      state.replaceSearchController = null;
      clearReplaceResults();
      state.replaceSong = null;
    }
  });
  $("replace-song-dialog").addEventListener("cancel", event => {
    if (state.playlistController) event.preventDefault();
  });
  $("replace-song-form").addEventListener("submit", event => {
    event.preventDefault();
    runReplaceSearch();
  });
  $("replace-song-results").addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest(".replace-result");
    if (!item) return;
    const result = {url: item.dataset.url, title: item.dataset.title || "Selected video"};
    if (event.target.closest(".preview-replace-song")) return previewReplaceResult(result);
    if (event.target.closest(".use-replace-song")) {
      if (!state.replaceSong) return;
      state.editingSong = {playlistId: state.replaceSong.playlistId, index: state.replaceSong.index, videos: state.replaceSong.videos};
      changeSong("replace", result.url, "replace-dialog");
    }
  });
}
