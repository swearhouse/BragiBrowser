export const usernameKey = "bragi.username";
export const autoShuffleKey = "bragi.autoShuffle";
export const loudnessKey = "bragi.loudness";
export const visualizerKey = "bragi.visualizer";
export const trackThumbsKey = "bragi.trackThumbs";
export const youtubeSearchInstanceKey = "bragi.youtubeSearchInstance";
export const volumeKey = "bragi.volume";
export const defaultYoutubeSearchInstance = "https://yt.chocolatemoo53.com";

export const state = {
  auth: null, playlists: [], selectedPlaylistId: null, controller: null, generation: 0, busy: false,
  localQueue: [], localQueueOrigins: [], localQueueSnapshot: null, localIndex: -1, localPlayingIndex: -1, localStarting: false, localTitle: "", localArtwork: null, localPrefetch: null, localUsingPrefetch: false, localRetry: null, artworkSource: null, artworkVersion: 0,
  castContext: null, castSession: null, castSessionVersion: 0, castMedia: null, castQueue: null, castToken: null, castLoading: false, preparingOutput: null,
  displayedPlaylist: null, displayedIsQueue: false, lastQueue: null,
  seeking: null, volumeEditing: null, volumePending: false, autoScrollTimer: null,
  visualizerAccess: "unchecked", localHasPlayed: false, localDirectUrl: "", playlistController: null,
  editingPlaylistId: null, editingSong: null, replaceSong: null, youtubeSearchInstance: defaultYoutubeSearchInstance,
  replaceSearchController: null, replacePreviewController: null, mediaSessionNeedsReclaim: false, trackThumbs: false, loudnessEnabled: true
};

export const visualizer = { context: null, source: null, analyser: null, sink: null, stream: null, frame: 0, failure: "", timeData: null, freqData: null, accent: "", mode: "", particles: [], lastEnergy: 0, history: null };
export const loudness = { context: null, source: null, gain: null, gainDb: null, info: null, failure: "" };
