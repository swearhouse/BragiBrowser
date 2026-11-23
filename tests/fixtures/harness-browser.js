(() => {
  const h = {};
  window.__harness = h;

  const makeVideos = () => [
    {name: "One", link: "https://youtu.be/abcdefghijk", thumbnail_url: "https://artwork.example/cover.png"},
    {name: "Bad", link: "https://youtu.be/12345678901"},
    {name: "One", link: "https://youtu.be/abcdefghijk", thumbnail_url: null}
  ];
  const videos = makeVideos();
  const queue = {id: "q", playlist_id: "p", name: "Mix", shuffled: false, videos};
  const initialPlaylists = [
    {id: "p", name: "Mix", videos: videos.map(video => ({...video, thumbnail_url: "https://artwork.example/playlist.png"}))},
    {id: "empty", name: "Empty", videos: []},
    {id: "other", name: "Other", videos: [videos[0]]}
  ];
  const createdPlaylists = [];
  const requests = [];
  const paletteRequests = [];
  const insertSizes = [];
  const insertCounts = [];
  const mediaSessionListeners = new Set();
  const mediaHandlers = {};
  const gates = {};
  const controls = {
    mode: "normal", configuredServerUrl: "https://server.example", configFailure: "",
    castBatchSize: 16, allowReplace: false, badAttempts: 0, loads: 0, cancelled: false,
    resolveEntered: false, proxyEntered: false, proxyCancelled: false, prefetchCancelled: false,
    deferredPrefetchUrl: null, currentQueue: queue,
    remoteVolume: 0.65, remoteMuted: false, remoteTime: 20, seekSupported: true,
    rejectSeek: false, rejectVolume: false, rejectMute: false, delayMute: false, remoteCommand: "",
    frameworkMediaAvailable: true, otherMediaSessions: [],
    localPaused: true, localTime: 0, localError: null, spectrumLevel: 0,
    lowFrequencyOnly: false, descendingSpectrum: false, captureSupported: true,
    captures: 0, stoppedCaptures: 0, storageFailure: null
  };
  h.controls = controls;
  h.gates = gates;
  h.requests = requests;
  h.paletteRequests = paletteRequests;
  h.insertSizes = insertSizes;
  h.insertCounts = insertCounts;
  h.videos = videos;
  h.queue = queue;
  h.initialPlaylists = initialPlaylists;
  h.createdPlaylists = createdPlaylists;
  h.keys = ["bragi.username", "bragi.autoShuffle", "bragi.visualizer"];

  const mediaSession = {
    metadata: null, playbackState: "none", position: null, unsupported: null,
    setActionHandler(action, handler) {
      if (action === this.unsupported) throw new TypeError("Unsupported action");
      mediaHandlers[action] = handler;
    },
    setPositionState(position) { this.position = position || null; }
  };
  h.mediaSession = mediaSession;
  h.mediaHandlers = mediaHandlers;
  Object.defineProperty(navigator, "mediaSession", {value: mediaSession, configurable: true});

  window.Image = function () {
    const image = document.createElement("canvas");
    image.width = image.height = 4;
    const context = image.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 4, 4);
    Object.defineProperty(image, "src", {set: value => { image.imageUrl = value; paletteRequests.push(image); }});
    return image;
  };

  window.AudioContext = class {
    constructor() { this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    createAnalyser() {
      return {
        fftSize: 256, frequencyBinCount: 128, connect() {}, disconnect() {},
        getByteFrequencyData(data) {
          data.fill(controls.lowFrequencyOnly || controls.descendingSpectrum ? 0 : controls.spectrumLevel);
          if (controls.lowFrequencyOnly || controls.descendingSpectrum) {
            for (let i = 0; i < 4; i++) data[i] = controls.descendingSpectrum ? controls.spectrumLevel * (4 - i) / 4 : controls.spectrumLevel;
          }
        }
      };
    }
    createGain() { return {gain: {value: 1}, connect() {}, disconnect() {}}; }
    resume() { this.state = "running"; return Promise.resolve(); }
  };

  Object.defineProperty(HTMLMediaElement.prototype, "paused", {get: () => controls.localPaused, configurable: true});
  Object.defineProperty(HTMLMediaElement.prototype, "duration", {get: () => 180, configurable: true});
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    get: () => controls.localTime, set: value => { controls.localTime = value; }, configurable: true
  });
  Object.defineProperty(HTMLMediaElement.prototype, "error", {get: () => controls.localError, configurable: true});
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {get: () => 2, configurable: true});
  HTMLMediaElement.prototype.captureStream = () => {
    controls.captures++;
    const track = {stop: () => { controls.stoppedCaptures++; }};
    return {getTracks: () => [track], getAudioTracks: () => [track]};
  };
  h.setCaptureSupported = value => {
    controls.captureSupported = value;
    if (value) {
      HTMLMediaElement.prototype.captureStream = () => {
        controls.captures++;
        const track = {stop: () => { controls.stoppedCaptures++; }};
        return {getTracks: () => [track], getAudioTracks: () => [track]};
      };
    } else delete HTMLMediaElement.prototype.captureStream;
  };
  HTMLMediaElement.prototype.play = function () {
    controls.localPaused = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function () {
    controls.localPaused = true;
    this.dispatchEvent(new Event("pause"));
  };
  HTMLMediaElement.prototype.load = () => {};

  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    const failure = controls.storageFailure;
    if (failure === "all" || (failure === "username" && key === "bragi.username")) {
      throw new DOMException("Storage is unavailable.", failure === "all" ? "SecurityError" : "QuotaExceededError");
    }
    return originalSetItem.call(this, key, value);
  };

  window.confirm = () => controls.allowReplace;

  const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({url, path, method: options.method, body: options.body, headers: options.headers,
      redirect: options.redirect, credentials: options.credentials, referrerPolicy: options.referrerPolicy, cache: options.cache});
    const mode = controls.mode;
    if (path.endsWith("/server-url.txt")) {
      if (controls.configFailure === "network") throw new TypeError("network failure");
      if (controls.configFailure === "missing") return new Response("Not found", {status: 404});
      return new Response(controls.configuredServerUrl, {status: 200});
    }
    if (path.endsWith("/playlists")) {
      if (options.method === "POST") {
        if (mode === "playlist-uncertain") throw new TypeError("network failure");
        if (mode === "playlist-invalid") return json({}, 400);
        const playlist = {id: `new-${createdPlaylists.length}`, name: JSON.parse(options.body).name, videos: []};
        if (mode === "playlist-delay") {
          return new Promise(resolve => { gates.finishCreate = () => { createdPlaylists.push(playlist); resolve(json({playlist}, 201)); }; });
        }
        createdPlaylists.push(playlist);
        return json({playlist}, 201);
      }
      if (mode === "invalid") return json({}, 401);
      if (mode === "login-delay") await new Promise(resolve => { gates.finishLogin = resolve; });
      return json({playlists: [...initialPlaylists, ...createdPlaylists]});
    }
    if (path.includes("/playlists/") && path.endsWith("/tracks")) {
      const id = decodeURIComponent(path.split("/").at(-2));
      const collection = initialPlaylists.some(item => item.id === id) ? initialPlaylists : createdPlaylists;
      const index = collection.findIndex(item => item.id === id);
      if (index < 0) return json({}, 404);
      if (options.method === "PATCH") {
        const body = JSON.parse(options.body);
        const current = collection[index].videos.map(video => ({name: video.name, link: video.link}));
        if (JSON.stringify(body.videos) !== JSON.stringify(current)) return json({}, 409);
        if (mode === "song-invalid") return json({}, 400);
        if (mode === "song-title-failed") return json({}, 422);
        const replace = () => {
          const video = {name: "Replacement title", link: body.url, thumbnail_url: "https://artwork.example/replacement.png"};
          collection[index] = {...collection[index], videos: collection[index].videos.map((item, position) => position === body.index ? video : item)};
          return json({playlist: collection[index]});
        };
        if (mode === "replace-delay") return new Promise(resolve => { gates.finishReplaceSong = () => resolve(replace()); });
        if (mode === "replace-uncertain") { replace(); throw new TypeError("network failure"); }
        if (mode === "replace-malformed") { replace(); return json({playlist: {id, name: "Other", videos: [null]}}); }
        return replace();
      }
      if (options.method === "DELETE") {
        const body = JSON.parse(options.body);
        const current = collection[index].videos.map(video => ({name: video.name, link: video.link}));
        if (JSON.stringify(body.videos) !== JSON.stringify(current)) return json({}, 409);
        const remove = () => {
          collection[index] = {...collection[index], videos: collection[index].videos.filter((_, position) => position !== body.index)};
          return json({playlist: collection[index]});
        };
        if (mode === "remove-delay") return new Promise(resolve => { gates.finishRemoveSong = () => resolve(remove()); });
        if (mode === "remove-uncertain") { remove(); throw new TypeError("network failure"); }
        return remove();
      }
      if (mode === "song-invalid") return json({}, 400);
      if (mode === "song-title-failed") return json({}, 422);
      if (mode === "song-full") return json({}, 409);
      const add = () => {
        const video = {name: "Fetched title", link: JSON.parse(options.body).url, thumbnail_url: "https://artwork.example/song.png"};
        collection[index] = {...collection[index], videos: [...collection[index].videos, video]};
        return json({playlist: collection[index]}, 201);
      };
      if (mode === "song-delay") return new Promise(resolve => { gates.finishAddSong = () => resolve(add()); });
      if (mode === "song-uncertain") { add(); throw new TypeError("network failure"); }
      if (mode === "song-malformed") { add(); return json({playlist: {id, name: "Other", videos: [null]}}, 201); }
      return add();
    }
    if (path.includes("/playlists/")) {
      const id = decodeURIComponent(path.split("/").pop());
      const collection = initialPlaylists.some(item => item.id === id) ? initialPlaylists : createdPlaylists;
      const index = collection.findIndex(item => item.id === id);
      if (index < 0) return json({}, 404);
      if (mode === "playlist-invalid") return json({}, 400);
      if (options.method === "PATCH") {
        collection[index] = {...collection[index], name: JSON.parse(options.body).name};
        if (mode === "playlist-uncertain") throw new TypeError("network failure");
        return json({playlist: collection[index]});
      }
      if (options.method === "DELETE") {
        collection.splice(index, 1);
        if (mode === "playlist-uncertain") throw new TypeError("network failure");
        return new Response(null, {status: 204});
      }
    }
    if (path.endsWith("/queue")) {
      if (mode === "uncertain" && options.method === "POST") throw new TypeError("network failure");
      if (options.method === "POST") {
        const shuffled = JSON.parse(options.body).shuffle;
        controls.currentQueue = mode === "tail-bad"
          ? {...queue, id: "tail-bad", videos: [videos[0], videos[2], videos[1]]}
          : shuffled
            ? {...queue, id: "shuffled", shuffled: true, videos: [videos[1], videos[0], videos[2]]}
            : queue;
      }
      return json({queue: controls.currentQueue}, options.method === "POST" ? 201 : 200);
    }
    if (path.endsWith("/cast-queue")) {
      if (mode === "cast-delay") {
        controls.resolveEntered = true;
        return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
          controls.cancelled = true;
          reject(new DOMException("Aborted", "AbortError"));
        }));
      }
      return json({token: "A".repeat(43), expires_in: 604800, batch_size: controls.castBatchSize});
    }
    if (path.endsWith("/resolve")) {
      const body = JSON.parse(options.body);
      if (controls.deferredPrefetchUrl && body.url === controls.deferredPrefetchUrl) {
        return new Promise((resolve, reject) => {
          gates.finishPrefetch = () => resolve(json({audio: {url: "https://media.example/signed-secret", title: "One", content_type: "audio/mp4"}}));
          options.signal.addEventListener("abort", () => {
            controls.prefetchCancelled = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, {once: true});
        });
      }
      if (mode === "queue-resolve-delay") {
        return new Promise(resolve => {
          gates.finishQueueResolve = () => resolve(json({audio: {url: "https://media.example/signed-secret", title: "One", content_type: "audio/mp4"}}));
        });
      }
      if (mode === "resolve-delay") {
        controls.resolveEntered = true;
        return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
          controls.cancelled = true;
          reject(new DOMException("Aborted", "AbortError"));
        }));
      }
      if (body.url.endsWith("12345678901")) {
        controls.badAttempts++;
        return json({}, 422);
      }
      return json({audio: {url: "https://media.example/signed-secret", title: "One", content_type: "audio/mp4"}});
    }
    if (path.endsWith("/audio-proxy")) {
      if (mode === "proxy-delay") {
        controls.proxyEntered = true;
        return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
          controls.proxyCancelled = true;
          reject(new DOMException("Aborted", "AbortError"));
        }));
      }
      if (mode === "proxy-failed") return json({}, 503);
      if (mode === "proxy-auth") return json({}, 401);
      if (mode === "invalid-proxy") return json({proxy_url: "https://evil.example/api/v1/audio-stream?token=proxy-secret", expires_in: 21600});
      return json({proxy_url: "/api/v1/audio-stream?token=proxy-secret", expires_in: 21600});
    }
    throw new Error("Unexpected request: " + path);
  };

  h.app = async () => {
    const [dom, state, api, settings, shell, playlists, localPlayback, cast, artwork, visualizer, player, config] = await Promise.all([
      import("/src/dom.js"), import("/src/state.js"), import("/src/api.js"), import("/src/settings.js"),
      import("/src/shell.js"), import("/src/playlists.js"), import("/src/localPlayback.js"), import("/src/cast.js"),
      import("/src/artwork.js"), import("/src/visualizer.js"), import("/src/player.js"), import("/src/config.js")
    ]);
    return {dom, state, api, settings, shell, playlists, localPlayback, cast, artwork, visualizer, player, config,
      stateObject: state.state, visualizerState: state.visualizer};
  };
  h.call = async (moduleName, method, args = []) => {
    const app = await h.app();
    return app[moduleName][method](...args);
  };
  h.setCastContext = async () => {
    const app = await h.app();
    app.stateObject.castContext = {getCurrentSession: () => window.currentSession || null};
    app.cast.updateCast();
  };
  h.resetMediaSessionCache = async () => (await h.app()).artwork.resetMediaSessionCache();
  h.updatePlayer = async () => (await h.app()).player.updatePlayer();
  h.updateCast = async () => (await h.app()).cast.updateCast();

  h.installCast = async () => {
    let nextItemId = 102;
    const media = {
      playerState: "PLAYING", currentItemId: 1, media: {duration: 200, metadata: {title: "Existing"}},
      addUpdateListener() {}, removeUpdateListener() {},
      getEstimatedTime: () => controls.remoteTime,
      supportsCommand: () => controls.seekSupported,
      seek: (request, resolve, reject) => {
        if (controls.rejectSeek) reject(); else { controls.remoteTime = request.currentTime; resolve(); }
      },
      pause: (request, resolve) => { controls.remoteCommand = "pause"; resolve(); },
      play: (request, resolve) => { controls.remoteCommand = "play"; resolve(); },
      stop: (request, resolve) => { controls.remoteCommand = "stop"; resolve(); },
      queueNext: resolve => { controls.remoteCommand = "next"; resolve(); },
      queuePrev: resolve => { controls.remoteCommand = "previous"; resolve(); },
      queueInsertItems: (request, resolve, reject) => {
        insertSizes.push(new TextEncoder().encode(JSON.stringify(request.items)).length);
        insertCounts.push(request.items.length);
        if (controls.mode === "insert-fail") { reject(); return; }
        const index = request.insertBefore == null ? media.items.length : media.items.findIndex(item => item.itemId === request.insertBefore);
        const items = request.items.map(item => ({...item, itemId: nextItemId++}));
        media.items.splice(index < 0 ? media.items.length : index, 0, ...items);
        resolve();
      }
    };
    const session = {
      getMediaSession: () => controls.frameworkMediaAvailable ? media : null,
      getSessionObj: () => ({media: [...controls.otherMediaSessions, media]}),
      getCastDevice: () => ({friendlyName: "Test"}),
      getVolume: () => controls.remoteVolume,
      setVolume: async value => { if (controls.rejectVolume) throw new Error("failed"); controls.remoteVolume = value; },
      isMute: () => controls.remoteMuted,
      setMute: async value => {
        if (controls.rejectMute) throw new Error("failed");
        if (controls.delayMute) await new Promise(resolve => { gates.finishMute = resolve; });
        controls.remoteMuted = value;
      },
      addEventListener: (type, listener) => { if (type === "media") mediaSessionListeners.add(listener); },
      removeEventListener: (type, listener) => { if (type === "media") mediaSessionListeners.delete(listener); },
      loadMedia: async request => {
        controls.loads++;
        h.lastLoad = request;
        if (controls.mode === "load-delay") await new Promise(resolve => { gates.finishLoad = resolve; });
        const updateMedia = () => {
          media.currentItemId = request.queueData.startIndex + 101;
          media.items = request.queueData.items.map((item, index) => ({...item, itemId: index + 101}));
          media.media = request.queueData.items[request.queueData.startIndex].media;
          nextItemId = 102;
          mediaSessionListeners.forEach(listener => listener({}));
        };
        if (controls.mode === "load-status-delay") { gates.finishMediaUpdate = updateMedia; return; }
        updateMedia();
      }
    };
    window.cast = {framework: {SessionEventType: {MEDIA_SESSION: "media", VOLUME_CHANGED: "volume"}}};
    window.chrome = window.chrome || {};
    window.chrome.cast = {Image: class { constructor(url) { this.url = url; } }, media: {
      MediaInfo: class { constructor(url, type) { this.url = url; this.type = type; } },
      MusicTrackMediaMetadata: class {}, QueueItem: class { constructor(media) { this.media = media; } },
      QueueInsertItemsRequest: class { constructor(items) { this.items = items; } },
      QueueData: class {}, LoadRequest: class { constructor(media) { this.media = media; } },
      RepeatMode: {REPEAT_OFF: "off"}, MediaCommand: {SEEK: "seek"},
      SeekRequest: class {}, PauseRequest: class {}, PlayRequest: class {}, StopRequest: class {}
    }};
    h.media = media;
    h.session = session;
    window.testSession = session;
    window.currentSession = session;
    await h.setCastContext();
  };

  h.captureScrollTimer = () => {
    const original = window.setTimeout;
    const originalClear = window.clearTimeout;
    h.scrollResume = null;
    window.setTimeout = function (fn, delay, ...args) {
      if (delay === 5000) { h.scrollResume = fn; return 987654; }
      return original.call(this, fn, delay, ...args);
    };
    window.clearTimeout = function (id) {
      if (id === 987654) h.scrollResume = null;
      return originalClear.call(this, id);
    };
    h.releaseScrollTimer = () => { window.setTimeout = original; window.clearTimeout = originalClear; };
  };

  h.shortenTimeout = (from, to) => {
    const original = window.setTimeout;
    window.setTimeout = function (fn, delay, ...args) { return original.call(this, fn, delay === from ? to : delay, ...args); };
    h.releaseShortenTimeout = () => { window.setTimeout = original; };
  };
})();
