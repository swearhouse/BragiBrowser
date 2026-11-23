import { $, message } from "./dom.js";
import { state } from "./state.js";
import { getCastMediaSession, castCommand, updateCast } from "./cast.js";
import { advanceLocal, stopLocal } from "./localPlayback.js";
import { cancelPreparation } from "./shell.js";
import { updateTrackHighlight } from "./playlists.js";
import { updateArtwork, syncMediaSession, setUpdatePlayer } from "./artwork.js";
import { prepareVisualizer, syncVisualizer } from "./visualizer.js";

const el = {
  audio: $("audio"), outputStatus: $("output-status"), stopBrowser: $("stop-browser"), playerTitle: $("player-title"),
  playPause: $("play-pause"), playPauseIcon: $("play-pause-icon"), stop: $("stop"), previous: $("previous"), next: $("next"),
  seek: $("seek"), seekDuration: $("seek-duration"), seekCurrent: $("seek-current"), volume: $("volume"), mute: $("mute"),
  muteIcon: $("mute-icon"), volumeValue: $("volume-value"), reclaim: $("reclaim-media-session")
};

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setFlag(node, property, value) {
  if (node[property] !== value) node[property] = value;
}

export function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function updatePlayer() {
  const audio = el.audio;
  const session = state.castContext && state.castContext.getCurrentSession();
  const casting = !!session;
  const media = getCastMediaSession(session);
  const hasLocal = !!audio.getAttribute("src") && state.localQueue.length > 0;
  const device = casting && session.getCastDevice();
  setText(el.outputStatus, casting ? (device && device.friendlyName || "Chromecast") : "This browser");
  setFlag(el.stopBrowser, "hidden", !casting || !hasLocal);
  const hasMedia = casting ? !!media && media.playerState !== "IDLE" : hasLocal;
  updateTrackHighlight();
  setText(el.playerTitle, casting
    ? hasMedia && media.media && media.media.metadata && media.media.metadata.title || "No receiver track loaded."
    : hasLocal ? state.localTitle : "No local track loaded.");
  const images = casting && hasMedia && media.media && media.media.metadata && media.media.metadata.images;
  updateArtwork(casting ? (Array.isArray(images) && images[0] && images[0].url || null) : hasLocal ? state.localArtwork : null);
  const target = casting ? media : audio.getAttribute("src");
  const track = casting ? media && media.currentItemId : state.localIndex;
  if (state.seeking && (state.seeking.casting !== casting || state.seeking.target !== target || state.seeking.track !== track)) state.seeking = null;
  if (state.volumeEditing && (state.volumeEditing.casting !== casting || state.volumeEditing.session !== session)) state.volumeEditing = null;
  const playing = hasMedia && (casting ? ["PLAYING", "BUFFERING"].includes(media.playerState) : !audio.paused && !audio.ended);
  setFlag(el.playPause, "disabled", !hasMedia || state.busy);
  setAttr(el.playPause, "aria-label", playing ? "Pause" : "Play");
  setFlag(el.playPause, "title", playing ? "Pause" : "Play");
  setText(el.playPauseIcon, playing ? "pause" : "play_arrow");
  setFlag(el.stop, "disabled", !hasMedia || state.busy);
  setFlag(el.previous, "disabled", state.busy || !hasMedia || (!casting && state.localIndex <= 0));
  setFlag(el.next, "disabled", state.busy || !hasMedia || (!casting && state.localIndex >= state.localQueue.length - 1));

  const duration = hasMedia ? (casting ? media.media && media.media.duration : audio.duration) : 0;
  const current = hasMedia ? (casting ? media.getEstimatedTime() : audio.currentTime) : 0;
  const canSeek = hasMedia && Number.isFinite(duration) && duration > 0 &&
    (!casting || media.supportsCommand(chrome.cast.media.MediaCommand.SEEK));
  setFlag(el.seek, "disabled", !canSeek || state.busy);
  const max = String(canSeek ? duration : 0);
  if (el.seek.max !== max) el.seek.max = max;
  setText(el.seekDuration, formatTime(duration));
  if (!state.seeking) {
    const value = String(canSeek && Number.isFinite(current) ? Math.min(duration, Math.max(0, current)) : 0);
    if (el.seek.value !== value) el.seek.value = value;
  }
  setText(el.seekCurrent, formatTime(Number(el.seek.value)));

  const volume = casting ? session && session.getVolume() : audio.volume;
  const muted = casting ? session.isMute() : audio.muted;
  setFlag(el.volume, "disabled", state.volumePending || (casting && (!session || !Number.isFinite(volume))));
  setFlag(el.mute, "disabled", state.volumePending || typeof muted !== "boolean");
  const muteLabel = typeof muted !== "boolean" ? "Mute unavailable" : muted ? "Unmute" : "Mute";
  setAttr(el.mute, "aria-label", muteLabel);
  setFlag(el.mute, "title", muteLabel);
  setText(el.muteIcon, muted ? "volume_off" : "volume_up");
  if (!state.volumeEditing && !state.volumePending) {
    const value = String(Number.isFinite(volume) ? volume : 0);
    if (el.volume.value !== value) el.volume.value = value;
  }
  setText(el.volumeValue, casting && !Number.isFinite(volume) ? "—" : `${Math.round(Number(el.volume.value) * 100)}%`);
  const reclaimable = hasMedia && state.mediaSessionNeedsReclaim && typeof navigator.mediaSession !== "undefined";
  setFlag(el.reclaim, "hidden", !reclaimable);
  setFlag(el.reclaim, "disabled", !reclaimable);
  if (reclaimable) el.reclaim.title = "Make this app the active system media session";
  syncMediaSession(hasMedia, playing, casting, media, duration, current, canSeek);
  syncVisualizer();
}

export async function setPlayback(shouldPlay) {
  if (!state.auth || el.playPause.disabled) return;
  const session = state.castContext && state.castContext.getCurrentSession();
  if (session) {
    const media = getCastMediaSession(session);
    if (!media || media.playerState === "IDLE") return;
    const playing = ["PLAYING", "BUFFERING"].includes(media.playerState);
    if (playing !== shouldPlay) await castCommand(shouldPlay ? "play" : "pause");
    return;
  }
  const audio = el.audio;
  if (shouldPlay && (audio.paused || audio.ended)) {
    prepareVisualizer();
    try { await audio.play(); }
    catch { message("Browser playback could not start. Try Play again or choose another track."); }
  } else if (!shouldPlay && !audio.paused) audio.pause();
  updatePlayer();
}

export function currentSeekSelection() {
  const session = state.castContext && state.castContext.getCurrentSession();
  const casting = !!session;
  const media = getCastMediaSession(session);
  return { casting, target: casting ? media : el.audio.getAttribute("src"), track: casting ? media && media.currentItemId : state.localIndex };
}

export async function seekPlayback(time, selection) {
  if (!selection || !state.auth || el.seek.disabled || !Number.isFinite(time)) return updatePlayer();
  time = Math.min(Number(el.seek.max), Math.max(0, time));
  if (selection.casting) {
    const session = state.castContext && state.castContext.getCurrentSession();
    const media = getCastMediaSession(session);
    if (!media || media !== selection.target || media.currentItemId !== selection.track) return updatePlayer();
    const request = new chrome.cast.media.SeekRequest();
    request.currentTime = time;
    try { await new Promise((resolve, reject) => media.seek(request, resolve, reject)); }
    catch { message("The receiver did not confirm the seek."); }
  } else if (!(state.castContext && state.castContext.getCurrentSession()) && el.audio.getAttribute("src") === selection.target && state.localIndex === selection.track) {
    try { el.audio.currentTime = time; }
    catch { message("Could not seek local playback."); }
  }
  updatePlayer();
}

export function seekFromMediaSession(time, offset = 0) {
  if (el.seek.disabled) return;
  const selection = currentSeekSelection();
  const current = selection.casting && selection.target ? selection.target.getEstimatedTime() : el.audio.currentTime;
  return seekPlayback(time === null ? current + offset : time, selection);
}

export function initPlayer() {
  setUpdatePlayer(updatePlayer);
  ["play", "pause", "ended", "emptied", "loadedmetadata", "durationchange", "timeupdate", "volumechange"].forEach(event => {
    el.audio.addEventListener(event, updatePlayer);
  });
  document.addEventListener("visibilitychange", syncVisualizer);
  el.playPause.addEventListener("click", () => {
    const session = state.castContext && state.castContext.getCurrentSession();
    const media = getCastMediaSession(session);
    const playing = session ? !!media && ["PLAYING", "BUFFERING"].includes(media.playerState) : !el.audio.paused && !el.audio.ended;
    return setPlayback(!playing);
  });
  el.stop.addEventListener("click", () => {
    if (state.castContext && state.castContext.getCurrentSession()) return castCommand("stop");
    cancelPreparation();
    stopLocal();
    message("Local playback stopped.");
  });
  el.next.addEventListener("click", () => {
    if (state.castContext && state.castContext.getCurrentSession()) return castCommand("next");
    return advanceLocal();
  });
  el.previous.addEventListener("click", () => {
    if (state.castContext && state.castContext.getCurrentSession()) return castCommand("previous");
    return advanceLocal(-1);
  });
  el.seek.addEventListener("input", () => {
    state.seeking = currentSeekSelection();
    setText(el.seekCurrent, formatTime(Number(el.seek.value)));
  });
  el.seek.addEventListener("change", () => {
    const selection = state.seeking;
    state.seeking = null;
    return seekPlayback(Number(el.seek.value), selection);
  });
  el.volume.addEventListener("input", () => {
    const session = state.castContext && state.castContext.getCurrentSession();
    const casting = !!session;
    state.volumeEditing = { casting, session };
    setText(el.volumeValue, `${Math.round(Number(el.volume.value) * 100)}%`);
    if (!casting) el.audio.volume = Number(el.volume.value);
  });
  el.volume.addEventListener("change", async () => {
    const selection = state.volumeEditing;
    state.volumeEditing = null;
    if (!selection) return updatePlayer();
    if (selection.casting) {
      const session = state.castContext && state.castContext.getCurrentSession();
      if (!session || session !== selection.session) return updatePlayer();
      const volume = Number(el.volume.value);
      state.volumePending = true;
      updatePlayer();
      try { await session.setVolume(volume); }
      catch { message("Could not change Chromecast volume."); }
      finally { state.volumePending = false; }
    }
    updatePlayer();
  });
  el.mute.addEventListener("click", async () => {
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
      el.audio.muted = !el.audio.muted;
    }
    updatePlayer();
  });
  el.stopBrowser.addEventListener("click", () => {
    if (state.preparingOutput === "local") cancelPreparation();
    stopLocal();
    message("Browser playback stopped. Receiver playback was not changed.");
  });
  el.reclaim.addEventListener("click", () => {
    state.mediaSessionNeedsReclaim = false;
    updatePlayer();
    message("Reclaim request sent; the browser may restore Bragi as the system media session.");
  });
  updatePlayer();
}
