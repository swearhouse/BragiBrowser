import { $, message } from "./dom.js";
import { state } from "./state.js";
import { api, ApiError, refreshPlaylists } from "./api.js";
import { reportError, setBusy } from "./shell.js";
import { startPlayback } from "./localPlayback.js";
import { queueNext, getCastMediaSession } from "./cast.js";

export const userScrollPauseMs = 5000;

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
  $("tracks").querySelectorAll("li").forEach((item, index) => {
    item.hidden = !playlist.videos[index].name.toLocaleLowerCase().includes(query);
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
      clearTimeout(state.autoScrollTimer);
      state.autoScrollTimer = null;
      if (isQueue) {
        startPlayback(null, { queueId: playlist.id, index });
      } else {
        const occurrence = playlist.videos.slice(0, index + 1).filter(track => track.name === video.name && track.link === video.link).length;
        startPlayback(playlist.id, { video, occurrence });
      }
    });
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
      const addAction = (label, className, handler) => {
        const action = document.createElement("button");
        action.type = "button";
        action.className = className;
        action.textContent = label;
        action.addEventListener("click", () => {
          menu.open = false;
          handler();
        });
        actions.append(action);
        return action;
      };
      const queue = addAction("Queue", "queue-song", () => queueNext(video));
      queue.disabled = state.busy || state.castLoading;
      addAction("Open in YouTube", "open-song", () => openYouTube(video));
      const edit = addAction("Edit", "edit-song", () => openSongEditor(playlist, index));
      const remove = addAction("Delete", "delete-song", () => deleteSong(playlist, index));
      edit.disabled = remove.disabled = state.busy || state.castLoading || !!state.playlistController;
      menu.append(toggle, actions);
      toggle.addEventListener("click", () => {
        if (!menu.open) document.querySelectorAll(".track-menu[open]").forEach(other => {
          if (other !== menu) other.open = false;
        });
      });
      item.append(menu);
    }
    $("tracks").append(item);
  });
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
  let changed = false;
  $("tracks").querySelectorAll(".track-button").forEach((button, i) => {
    if (i === highlighted && !button.hasAttribute("aria-current")) {
      button.setAttribute("aria-current", "true");
      changed = true;
    }
    else if (i !== highlighted && button.hasAttribute("aria-current")) button.removeAttribute("aria-current");
  });
  if (changed && state.autoScrollTimer === null) centerCurrentTrack();
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

export function openSongEditor(playlist, index) {
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

export function deleteSong(playlist, index) {
  if (!state.auth || state.playlistController || state.busy || state.castLoading) return;
  const videos = playlist.videos.map(video => ({name: video.name, link: video.link}));
  if (!window.confirm(`Remove "${videos[index].name}" from this playlist?`)) return;
  state.editingSong = {playlistId: playlist.id, index, videos};
  changeSong("delete");
}

export async function changeSong(action, url) {
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
      const text = action === "replace" && error.status === 400 ? "Enter a valid HTTPS YouTube video URL." :
        action === "replace" && error.status === 422 ? "Could not retrieve the YouTube video title. Check that the video is available and try again." :
        error.message || "Could not change the song.";
      if ($("edit-song-dialog").open) {
        $("edit-song-error").textContent = text;
        $("edit-song-error").hidden = false;
      } else message(text);
    }
  } finally {
    if (state.playlistController === controller) {
      state.playlistController = null;
      $("edit-song-save").disabled = false;
      $("edit-song-cancel").disabled = false;
      $("edit-song-delete").disabled = false;
      if (!$("edit-song-dialog").open) state.editingSong = null;
      setBusy(state.busy);
    }
  }
}

export function initPlaylists() {
  ["wheel", "touchmove", "pointerdown", "keydown"].forEach(type => {
    $("tracks").addEventListener(type, pauseAutoScroll, { passive: true });
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
}
