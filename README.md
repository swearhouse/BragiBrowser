# Bragi Browser

A browser playback client for BragiServer. It reads your playlists, creates
server queue snapshots, and plays locally or sends an ordered queue to a
Chromecast using Google's Cast Web Sender SDK.

## Setup

1. For testing, the client accepts BragiServer's default HTTP deployment.
   HTTP exposes Basic credentials to the network, so use it only in a trusted
   test environment. For production, use HTTPS through a trusted reverse proxy.
   Do not expose BragiServer directly to the internet.
2. Serve this folder from a trusted HTTPS website, or use `localhost` for
   development. For example, run `python -m http.server 8765` in this folder
   and open `http://localhost:8765`. Do not open the HTML file directly.
3. If the client and API have different origins, add the **exact client
   origin**, such as `http://localhost:8765`, in BragiServer's management UI
   under Settings. CORS, TLS certificates, browser network policies and mixed
   content can prevent connections. Redirects are rejected.
4. Enter the HTTP or HTTPS server URL and an existing account's credentials. The password,
   authentication header, and resolved media URLs are held in memory only; signing out or reloading
   requires signing in again. Sign-out stops local playback, not Cast playback.
   After a successful connection the server URL and username are saved in browser localStorage
   and prefilled read-only on future visits from the same browser and client origin.
   Use **Edit connection details** to change them, and lock them again if desired.
   The auto shuffle and visualizer settings are also saved there. Clear the browser's site data
   to remove them; they are not removed on sign-out.
   Browsers may block requests from an HTTPS client page to an HTTP server as
   mixed content; use `http://localhost:8765` for local testing.

### Docker

Copy this folder to the Docker host, then build and run the static client:

```sh
docker compose up -d --build
```

On CasaOS, run this command from the project folder on the CasaOS machine.
Open `http://<host-ip>:8765` from your browser. The container serves only the
client; it does not include BragiServer. Enter a server URL reachable from the
browser, not a Docker-internal hostname unless the browser can resolve it. If
the origins differ, allow the exact client origin in BragiServer's Settings.

The Compose port binding is reachable on the host's network interfaces; use it
only on a trusted network. To restrict it to the Docker host, change the
binding in `compose.yaml` to `127.0.0.1:8765:80` and open
`http://localhost:8765` on that host. For production, put the client behind a
trusted HTTPS reverse proxy and use HTTPS for BragiServer as well. Cast
requires a supported browser and a secure context; plain HTTP on a LAN address
may not work.

Click the Bragi logo or name to hide or show the playlist sidebar.
Select a playlist in the sidebar to inspect its tracks, then press **Play
playlist** in the sidebar, or select a track to start there and continue
through the rest of the queue. Use **Search songs** above the track list to
filter the displayed playlist or queue by title; its heading shows the total
song count, and playback queues are unchanged.
Enable **Auto shuffle** in **Settings** to shuffle
new queues automatically; it is off by default and does not change existing
queues. With auto shuffle enabled, the server shuffles first
and playback starts at the selected track's position in that order. Selecting a
track in a displayed server queue uses that snapshot; if another client has
replaced it, select a playlist to create a new queue. Select **New** in the
sidebar to create an empty playlist. Select a playlist and use **Edit** to
rename or delete it; deletion requires confirmation. These changes do not
alter an existing playback queue. Select **Add song** and paste an HTTPS
YouTube video link; the server fetches its title automatically. Added songs
appear in new queues, not in an already playing queue. Use the edit button
beside a song in a saved playlist to replace its YouTube link or delete it.
Deletion requires confirmation; both actions leave existing queues unchanged.
Reorder tracks in BragiServer.

The current track is highlighted when it can be matched to the displayed
playlist or queue, including while paused. Cast highlighting depends on the
receiver reporting this client's queue metadata.

For Chromecast, use a supported Cast-enabled browser in a secure context and
allow the Cast SDK to load from Google. Connect using the Cast button and
choose a playlist. The connected receiver is selected automatically; without a
Cast session the client uses the browser. Existing receiver media is
never intentionally replaced without confirmation. Receiver status is distinct
from the shared server queue.

The interface loads Material Symbols from Google Fonts; button text remains
available if the icon font cannot be loaded.

## Playback and limitations

- Starting a playlist replaces the user's shared server queue. The client preserves
  the server's order and duplicates. Identical duplicate tracks have no IDs;
  a selected duplicate is matched by its occurrence among identical entries.
- When a queue track includes an HTTPS `thumbnail_url`, the player shows it as
  artwork and includes it in Cast metadata. If it is absent, invalid, or cannot
  load, the player retains its placeholder. The image is fetched from its host;
  a connected Cast receiver may also fetch it. The interface derives an accent
  from the current artwork when its host permits cross-origin image sampling;
  otherwise it uses the default accent.
- For local playback, failed track resolution is attempted three times, then
  skipped and recorded in the on-page activity list. Local playback resolves tracks as they
  are reached. The browser may require pressing Play in the player
  after asynchronous resolution; a media playback error skips the track.
- The player controls a connected receiver, or the browser when no receiver is
  connected. Connecting or disconnecting does not transfer or stop existing
  playback. If browser playback continues after connecting, use **Stop browser
  playback** to stop it without affecting the receiver. Seeking requires a
  known duration and, for Cast, receiver
  support. Use the volume icon to mute or unmute without changing the volume
  level. Cast volume and mute controls reflect receiver changes from other
  senders; local and receiver settings are independent.
- **Settings** offers spectrum bars (the default), mirrored bars, a radial
  spectrum, a waveform, or off. Spectrum bars spread the active frequency
  range across the card; mirrored bars spread the spectrum symmetrically from
  the center. The visualizer only analyzes
  browser playback, using a separate captured stream;
  it does not analyze Chromecast audio. It requires browser support for
  `AudioContext` and `captureStream()`, and a BragiServer with the audio proxy
  endpoint. For each browser track with the visualizer enabled, the client
  requests a temporary proxy URL and plays audio through the server. If proxy
  preparation or playback fails, it retries the direct stream without analysis.
  Enabling the visualizer during playback may take effect on the next track.
  Proxy URLs are bearer credentials held in memory; configure server and reverse
  proxy access logs not to record their query strings.
- Cast queues use BragiServer links which resolve songs when requested. The
  first song is loaded immediately and the remaining queue is sent in batches:
  keep the browser open until it reports the queue was sent. The receiver
  batch size is set in BragiServer's admin Settings (default 16); batches may
  be split further to fit Cast message limits. The receiver
  needs to reach BragiServer and the resulting YouTube audio URLs. Links expire
  after seven days, a server restart, or any account-file change. Cast uses
  MP4 audio only. Receiver handling of unavailable songs, redirects, seeking,
  and sender closure requires real-device testing; automatic skipping is not
  guaranteed. Keep Cast link query strings out of server and proxy access logs.
- Signing out or changing Cast sessions can cancel preparation but cannot undo
  a server queue request already received by the server. A timed-out queue creation has an unknown outcome; the client
  checks the current queue and does not automatically retry. Once a Cast load
  has been sent it cannot be cancelled by this client.
- This client cannot reorder tracks or manage accounts. Use the server management UI.

See [CLIENT_GUIDE.md](CLIENT_GUIDE.md) for the API contract and security
considerations.

## Browser checks

With the development server running, open `http://localhost:8765/tests/client.html`
to run the mocked client checks. These do not replace testing against a real
HTTPS BragiServer and Chromecast.
