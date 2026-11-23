import { $, message } from "./dom.js";
import { state } from "./state.js";
import { getCastMediaSession, castCommand, updateCast } from "./cast.js";
import { advanceLocal, stopLocal } from "./localPlayback.js";
import { cancelPreparation } from "./shell.js";
import { updateTrackHighlight } from "./playlists.js";
import { updateArtwork, syncMediaSession } from "./artwork.js";
import { prepareVisualizer, syncVisualizer } from "./visualizer.js";

export function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function updatePlayer() {
  const audio = $("audio");
  const session = state.castContext && state.castContext.getCurrentSession();
  const casting = !!session;
  const media = getCastMediaSession(session);
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
  syncMediaSession(hasMedia, playing, casting, media, duration, current, canSeek);
  syncVisualizer();
}

export async function setPlayback(shouldPlay) {
  if (!state.auth || $("play-pause").disabled) return;
  const session = state.castContext && state.castContext.getCurrentSession();
  if (session) {
    const media = getCastMediaSession(session);
    if (!media || media.playerState === "IDLE") return;
    const playing = ["PLAYING", "BUFFERING"].includes(media.playerState);
    if (playing !== shouldPlay) await castCommand(shouldPlay ? "play" : "pause");
    return;
  }
  const audio = $("audio");
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
  return { casting, target: casting ? media : $("audio").getAttribute("src"), track: casting ? media && media.currentItemId : state.localIndex };
}

export async function seekPlayback(time, selection) {
  if (!selection || !state.auth || $("seek").disabled || !Number.isFinite(time)) return updatePlayer();
  time = Math.min(Number($("seek").max), Math.max(0, time));
  if (selection.casting) {
    const session = state.castContext && state.castContext.getCurrentSession();
    const media = getCastMediaSession(session);
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
}

export function seekFromMediaSession(time, offset = 0) {
  if ($("seek").disabled) return;
  const selection = currentSeekSelection();
  const current = selection.casting && selection.target ? selection.target.getEstimatedTime() : $("audio").currentTime;
  return seekPlayback(time === null ? current + offset : time, selection);
}

export function initPlayer() {
  ["play", "pause", "ended", "emptied", "loadedmetadata", "durationchange", "timeupdate", "volumechange"].forEach(event => {
    $("audio").addEventListener(event, updatePlayer);
  });
  document.addEventListener("visibilitychange", syncVisualizer);
  $("play-pause").addEventListener("click", () => {
    const session = state.castContext && state.castContext.getCurrentSession();
    const media = getCastMediaSession(session);
    const playing = session ? !!media && ["PLAYING", "BUFFERING"].includes(media.playerState) : !$("audio").paused && !$("audio").ended;
    return setPlayback(!playing);
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
    state.seeking = currentSeekSelection();
    $("seek-current").textContent = formatTime(Number($("seek").value));
  });
  $("seek").addEventListener("change", () => {
    const selection = state.seeking;
    state.seeking = null;
    return seekPlayback(Number($("seek").value), selection);
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
}
