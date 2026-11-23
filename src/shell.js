import { $, message } from "./dom.js";
import { state } from "./state.js";
import { refreshPlaylists, ApiError } from "./api.js";
import { configuredServerBase } from "./config.js";
import { rememberUsername, usernameSaveFailed, closeSettings } from "./settings.js";
import { cancelLocalPrefetch, stopLocal, retryPrefetchedLocal } from "./localPlayback.js";
import { stopVisualizer } from "./visualizer.js";
import { showTracks, renderPlaylists } from "./playlists.js";
import { updatePlayer } from "./player.js";

export function setBusy(value) {
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
  document.querySelectorAll(".delete-song").forEach(button => {
    button.disabled = value || state.castLoading || !!state.playlistController;
  });
  document.querySelectorAll(".queue-song").forEach(button => {
    button.disabled = value || state.castLoading;
  });
  updatePlayer();
  if (!value && state.localRetry) queueMicrotask(retryPrefetchedLocal);
}

export function cancelPreparation() {
  state.generation++;
  if (state.controller) state.controller.abort();
  state.controller = null;
  state.preparingOutput = null;
  if (state.localStarting) stopLocal();
  setBusy(false);
}

export function signOut(text = "Signed out. Cast playback was not stopped.") {
  clearTimeout(state.autoScrollTimer);
  state.autoScrollTimer = null;
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
  state.lastQueue = null;
  state.castQueue = null;
  state.castToken = null;
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

export function reportError(error) {
  if (error.name === "AbortError") return;
  if (error.status === 401) signOut(error.message);
  else message(error.message || "An unexpected error occurred.");
}

export function initShell() {
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    $("login-button").disabled = true;
    try {
      const username = $("username").value;
      rememberUsername(username);
      if (!username) throw new ApiError("Enter a username.");
      if (username.includes(":")) throw new ApiError("A Basic authentication username cannot contain a colon.");
      const password = $("password").value;
      const base = await configuredServerBase();
      const bytes = new TextEncoder().encode(username + ":" + password);
      const header = "Basic " + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
      const auth = { base, header };
      const playlists = await refreshPlaylists(auth);
      state.auth = auth;
      state.playlists = playlists;
      $("password").value = "";
      $("login-panel").hidden = true;
      $("library").hidden = !$("settings-panel").hidden;
      $("signout").hidden = false;
      renderPlaylists();
      message(!usernameSaveFailed ? "Connected. Choose a playlist and output." :
        "Connected, but the username could not be saved in browser storage.");
    } catch (error) { reportError(error); }
    finally { $("login-button").disabled = false; }
  });
  $("signout").addEventListener("click", () => signOut());
}
