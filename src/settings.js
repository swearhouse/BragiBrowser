import { $, message } from "./dom.js";
import { state, usernameKey, autoShuffleKey, visualizerKey, trackThumbsKey, youtubeSearchInstanceKey, defaultYoutubeSearchInstance } from "./state.js";
import { prepareVisualizer, stopVisualizer, syncVisualizer } from "./visualizer.js";
import { centerCurrentTrack, showTracks } from "./playlists.js";

export let usernameSaveFailed = false;

export function rememberUsername(username) {
  try {
    localStorage.setItem(usernameKey, username);
    usernameSaveFailed = false;
  } catch {
    usernameSaveFailed = true;
    message("Browser storage is unavailable; the username cannot be remembered.");
  }
}

export function closeSettings() {
  $("settings-panel").hidden = true;
  $("login-panel").hidden = !!state.auth;
  $("library").hidden = !state.auth;
  $("open-settings").focus();
  syncVisualizer();
  if (state.autoScrollTimer === null) centerCurrentTrack();
}

export function initSettings() {
  try {
    const savedUsername = localStorage.getItem(usernameKey);
    if (savedUsername) $("username").value = savedUsername;
    const savedAutoShuffle = localStorage.getItem(autoShuffleKey);
    if (savedAutoShuffle === "true" || savedAutoShuffle === "false") $("auto-shuffle").checked = savedAutoShuffle === "true";
    else if (savedAutoShuffle !== null) message("The saved auto shuffle setting is invalid; auto shuffle is off.");
    const savedVisualizer = localStorage.getItem(visualizerKey);
    if (["bars", "mirrored", "radial", "wave", "off"].includes(savedVisualizer)) $("visualizer-mode").value = savedVisualizer;
    else if (savedVisualizer !== null) message("The saved visualizer setting is invalid; spectrum bars are selected.");
    const savedThumbs = localStorage.getItem(trackThumbsKey);
    if (savedThumbs === "true" || savedThumbs === "false") state.trackThumbs = savedThumbs === "true";
    else if (savedThumbs !== null) message("The saved track thumbnails setting is invalid; thumbnails are hidden.");
    $("show-track-thumbs").checked = state.trackThumbs;
    const savedSearchInstance = localStorage.getItem(youtubeSearchInstanceKey);
    if (typeof savedSearchInstance === "string" && savedSearchInstance.trim()) {
      try {
        const url = new URL(savedSearchInstance.trim());
        if (url.protocol === "https:") state.youtubeSearchInstance = url.origin;
        else message("The saved YouTube search instance is invalid; the default instance is selected.");
      } catch {
        message("The saved YouTube search instance is invalid; the default instance is selected.");
      }
    }
    $("youtube-search-instance").value = state.youtubeSearchInstance;
  } catch {
    message("Browser storage is unavailable; the username and settings cannot be remembered.");
  }

  $("username").addEventListener("input", () => rememberUsername($("username").value));
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
    $("diagnostics-panel").hidden = true;
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
    if ($("visualizer-mode").value === "off") stopVisualizer(true);
    else prepareVisualizer();
    syncVisualizer();
  });
  $("show-track-thumbs").addEventListener("change", () => {
    state.trackThumbs = $("show-track-thumbs").checked;
    try {
      localStorage.setItem(trackThumbsKey, String(state.trackThumbs));
      message("Track thumbnails setting saved.");
    } catch {
      message("Browser storage is unavailable; track thumbnails changed for this page but was not saved.");
    }
    if (state.displayedPlaylist) showTracks(state.displayedPlaylist, state.displayedIsQueue);
  });
  $("youtube-search-instance").addEventListener("change", () => {
    const raw = $("youtube-search-instance").value.trim();
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") throw new Error("HTTPS required");
      state.youtubeSearchInstance = url.origin;
      $("youtube-search-instance").value = state.youtubeSearchInstance;
      localStorage.setItem(youtubeSearchInstanceKey, state.youtubeSearchInstance);
      message("YouTube search instance saved.");
    } catch {
      $("youtube-search-instance").value = state.youtubeSearchInstance;
      message("Enter a valid HTTPS Invidious instance URL.");
    }
  });
}
