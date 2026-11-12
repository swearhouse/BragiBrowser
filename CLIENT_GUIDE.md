# BragiServer playback client guide

This document describes the current server contract for an AI or developer
building a separate playback client. The client platform, UI design, and
deployment method have **not** been chosen. Ask the user before making those
decisions; do not assume a web, Android, iOS, or desktop application.

The server implementation and tests are authoritative if they differ from
this guide: [client API](src/bragi_server/client_api.py),
[resolver](src/bragi_server/cast_test_youtube.py),
[API tests](tests/test_client_api.py), and [setup](Readme.md).

## Goal and boundaries

Build a client that can connect to BragiServer, authenticate, show the signed-in
user's playlists, prepare a normal or shuffled queue, and use a Chromecast
sender SDK to load and control playback. The intended experience is for the
receiver to continue advancing a loaded queue when the client closes.

Current division of responsibility:

| Responsibility | Owner |
| --- | --- |
| Accounts, saved playlists, shuffle, temporary queue snapshot | Server |
| Resolving a YouTube link to a temporary direct audio URL | Server |
| Proxying a resolved audio stream for browser playback | Server |
| Chromecast discovery, connection, queue loading, controls and status | Client and receiver |
| Advancing a queue already loaded on Chromecast | Receiver |

The server does not control Chromecast, track live playback status, or refresh
URLs already loaded on the receiver. The browser audio proxy is separate from
Cast playback. The client should use the
receiver's reported state when connected, not present the server queue as
proof that audio is playing. More details and unverified behavior are below.

The playback API can create, rename, and delete playlists and add, replace, or remove
tracks; reordering tracks and managing users remain in the server management UI.
`admin` has broader management UI access but
the playback API restricts every account, including `admin`, to its own data.

## Connection and authentication

- Let the user configure the BragiServer base URL, including scheme and
  port; do not hardcode a LAN address. Compose currently publishes port 8000.
- API paths are under `/api/v1`. `GET /health` is an unauthenticated health
  check returning `{"status": "ok"}`; it does not verify credentials.
- API requests require HTTP Basic authentication using an existing server
  username and password, except that audio-stream GETs use a bearer token in
  the URL. There is no API login or logout endpoint. A management UI session
  cookie is separate and does not authenticate the playback API.
- Validate credentials by making an authenticated request, such as
  `GET /api/v1/playlists`. An empty playlist list is still a successful login.
  A password change or deletion takes effect on subsequent requests.
- HTTP is available for local testing. Use HTTPS for credentials and proxy
  tokens in production, including on a LAN. Basic authentication is encoding,
  not encryption. HTTPS requires appropriate deployment configuration, such
  as a trusted reverse proxy. Do not silently downgrade HTTPS or bypass
  certificate verification.
- Never log passwords, Basic authorization headers, signed audio URLs, or
  proxy URLs containing bearer tokens.
  If the user wants persistent login, agree on the platform-appropriate
  secure credential storage; do not write passwords to plain configuration
  files. Do not send credentials to a different origin on redirects.
- BragiServer stores its own account passwords in plaintext and has no API
  rate limiting. Do not expose it directly to the internet.

## Browser-specific access

Cross-origin access to the client API is disabled by default. An administrator
can add the **exact client origin** (scheme, hostname, and port, without a
path or trailing slash) in the server management UI under **Settings**.
Changes apply immediately and are stored in the server's persistent
`settings.json`. Only allow trusted sites. Same-origin web clients and native
clients do not require a CORS entry.

The API responds to preflight requests for `GET`, `POST`, `PATCH`, and `DELETE`, and
allows `Authorization`, `Content-Type`, and `Range` headers for allowed origins.
It exposes `Content-Length`, `Content-Range`, and `Accept-Ranges`.
CORS is not authentication. Browsers can hide the actual response for a
disallowed origin, so report network/CORS failures distinctly from an HTTP
401 when the response is unavailable. HTTPS browser pages may also be
blocked from calling an HTTP server as mixed content.

## HTTP contract

The examples use placeholder IDs and URLs; they are not real user data.
Send JSON requests with `Content-Type: application/json`. Send Basic
authentication for API requests except audio-stream GETs. Successful responses
and explicitly handled API errors are JSON except for audio streams and empty
204 responses to DELETE and preflight OPTIONS.
API responses include `Cache-Control: no-store`; do not persist resolved URLs.
Unexpected server, proxy, routing, or network errors may not be JSON, so
check the status and content type before parsing and handle missing responses.

### List playlists

`GET /api/v1/playlists` returns 200:

```json
{
  "playlists": [
    {
      "id": "playlist-id",
      "name": "Example mix",
      "videos": [
        {"name": "First track", "link": "https://youtu.be/abcdefghijk"},
        {"name": "Second track", "link": "https://youtu.be/12345678901"}
      ]
    }
  ]
}
```

`playlists` may be empty. `videos` is ordered and may be empty. A video has
only `name` and `link`; entries may repeat and have no unique track ID.
Treat playlist IDs as opaque and URL-encode them when used in a path.

### Create an empty playlist

`POST /api/v1/playlists` accepts `{"name": "New playlist"}` and returns
201 with `{"playlist": {"id": "...", "name": "New playlist", "videos": []}}`.
Names are trimmed and must contain 1–200 characters; invalid input returns
400. The new playlist belongs to the authenticated user. If the request
outcome is uncertain, check the playlist list before retrying.

### Read a playlist

`GET /api/v1/playlists/<playlist-id>` returns 200 with the same playlist
shape wrapped in `{"playlist": {...}}`. It returns 404 with
`{"error": "Playlist not found."}` for a missing playlist or one belonging
to another user.

### Rename or delete a playlist

`PATCH /api/v1/playlists/<playlist-id>` accepts `{"name": "New name"}` and
returns 200 with `{"playlist": {...}}`. Names are trimmed and must contain
1–200 characters; invalid input returns 400. Existing tracks are preserved.
`DELETE /api/v1/playlists/<playlist-id>` returns 204 with no body. Both
operations return 404 if the playlist does not exist or belongs to another
user. They do not modify an existing queue snapshot or receiver playback.
If the outcome is uncertain, refresh the playlist list before retrying.

### Add a song

`POST /api/v1/playlists/<playlist-id>/tracks` accepts
`{"url": "https://youtu.be/abcdefghijk"}`. The server retrieves the video
title from YouTube and appends the song to the owned playlist. It returns 201
with the updated `{"playlist": {...}}`, including the derived thumbnail.
The link must identify an HTTPS YouTube video with an 11-character ID. Invalid
input returns 400, an unavailable playlist returns 404, a playlist already
containing 5,000 tracks returns 409, and a failed title lookup returns 422. Duplicates
are allowed. Existing queue snapshots and playback are unchanged.

A timed-out or disconnected request may still complete. Check the playlist
again before retrying; an automatic retry could add a duplicate.

### Replace or remove a song

`PATCH /api/v1/playlists/<playlist-id>/tracks` accepts a replacement HTTPS
YouTube `url`, plus the zero-based `index` and last-seen `videos` snapshot
described below. The server fetches the new title and returns 200 with the
updated `{"playlist": {...}}`. Invalid input returns 400, an unavailable
playlist 404, a changed snapshot 409, and a failed title lookup 422. It
replaces only the specified occurrence and leaves existing queues unchanged.

`DELETE /api/v1/playlists/<playlist-id>/tracks` accepts a zero-based track
index and the entire last-seen ordered track list, omitting derived thumbnail
fields:

```json
{"index": 0, "videos": [{"name": "First track", "link": "https://youtu.be/abcdefghijk"}]}
```

It returns 200 with the updated `{"playlist": {...}}`. It removes only the
specified occurrence, even when songs repeat. A changed track list returns
409 and removes nothing; refresh before retrying. Invalid input returns 400
and an unavailable playlist returns 404. Existing queues and playback are
unchanged. If the request times out, check the playlist before retrying.

### Create or replace the active queue

`POST /api/v1/queue` accepts:

```json
{"playlist_id": "playlist-id", "shuffle": true}
```

`playlist_id` must be a nonempty string. `shuffle` is an optional JSON
boolean, defaulting to `false`. A successful request returns 201:

```json
{
  "queue": {
    "id": "queue-id",
    "playlist_id": "playlist-id",
    "name": "Example mix",
    "shuffled": true,
    "videos": [
      {"name": "Second track", "link": "https://youtu.be/12345678901"},
      {"name": "First track", "link": "https://youtu.be/abcdefghijk"}
    ]
  }
}
```

The queue is an ordered snapshot, not resolved audio or the Cast receiver
queue. Shuffle does not modify the saved playlist; a random shuffle can
produce the original order. Playlist edits after creation do not update this
snapshot. A queue ID identifies a particular creation, not a track.

Each user has exactly one active server queue; a successful POST replaces it,
including when another client created it. Failed requests do not replace it.
Queues are in server memory, disappear on server restart or account deletion,
and are independent of any receiver queue. There is no per-device server
queue, position, repeat mode, queue editing, or status endpoint.

Invalid input returns 400, an unavailable or other user's playlist returns
404, and an empty playlist returns 422. If a POST times out, its outcome may
be unknown: check `GET /api/v1/queue` before retrying. Retrying creates a
new queue and, if shuffled, potentially a different order.

### Read or clear the active queue

`GET /api/v1/queue` returns 200 with `{"queue": {...}}`, or 404 with
`{"error": "Queue not found."}` when no queue exists.

`DELETE /api/v1/queue` returns 204 with no body, whether or not a queue
exists. Clearing or replacing a server queue does **not** stop, clear, or
otherwise update a queue already loaded on Chromecast. Likewise, a queue
missing after restart does not prove that the receiver stopped playing.

### Resolve one track

`POST /api/v1/resolve` accepts:

```json
{"url": "https://youtu.be/abcdefghijk"}
```

On success it returns 200:

```json
{
  "audio": {
    "url": "https://temporary-audio.example/stream",
    "title": "Example title",
    "content_type": "audio/mp4"
  }
}
```

`url` is a temporary direct HTTPS media URL, not a BragiServer endpoint.
Pass it and the returned `content_type` to the Cast SDK; do not substitute a
YouTube page URL. The current resolver selects supported m4a or webm audio
and returns `audio/mp4` or `audio/webm`. It does not return an expiry time or
guarantee that the receiver can play the selected stream.

Invalid input or an unsupported video URL returns 400; extraction or lack of
a supported direct stream returns 422. This resolver requires HTTPS YouTube
video URLs with an 11-character video ID. The saved-playlist validator is
less strict about IDs, so a saved link can still fail resolution. Surface
that failure rather than assuming every saved track is playable.

### Proxy audio for browser playback

`POST /api/v1/audio-proxy` accepts `{"url": "<resolved audio URL>"}` with
Basic authentication and returns `{"proxy_url": "/api/v1/audio-stream?token=...",
"expires_in": 21600}`. Resolve the relative URL against the configured server.
The token is a bearer credential: do not log, persist, share, or send it to
analytics. Configure reverse proxies to omit query strings or disable access
logs for the stream endpoint.

Stream GETs need no Basic header. Use `crossOrigin="anonymous"` for browser
audio and configure the exact browser origin in the server's allowed origins.
Tokens support repeated range requests for up to six hours, but are invalidated
by server restart or any change to `users.json`; the source may expire sooner.
The proxy forwards range requests and upstream 200, 206, and 416 responses.

Invalid proxy input returns 400, invalid or expired stream tokens return 401,
upstream failures return 502, and exhausted token capacity returns 503.

### On-demand Cast playback

`POST /api/v1/cast-queue` with Basic authentication and
`{"queue_id": "<current queue id>"}` returns
`{"token": "<bearer token>", "expires_in": 604800, "batch_size": 16}`.
The batch size is configured in BragiServer's admin Settings (1–5000, default
16) and applies to the prepared queue. Clients must split large messages
further to fit Cast message limits. For each zero-based
index, give the receiver `/api/v1/cast-stream/<index>?token=<token>` on the
configured server as an `audio/mp4` URL. Each request resolves the stored
YouTube link and redirects to a temporary Googlevideo MP4 stream; audio flows
directly from Googlevideo to the receiver. The receiver needs access to both.

The token grants access to the snapshot for seven days, survives replacing the
shared queue, and is invalidated on restart or any change to `users.json`.
Do not log or share it; omit query strings from Cast-stream access logs. The
creation endpoint returns 409 if the current queue changed, or 503 at capacity.
Stream requests return 401 for invalid tokens, 404 for an invalid index, 422
if resolution fails, or 502 for an unsupported destination. Receiver handling
of redirects, seeking, failures and sender closure needs real-device testing.

### Common failures

- 401: missing, invalid, changed, or deleted credentials on Basic-authenticated
  requests; prompt the user to authenticate again. Stream-token failures also
  return 401, but do not include a Basic authentication challenge.
- 400: malformed request or invalid input.
- 404: requested playlist or active queue is unavailable; distinguish it from
  a generic network failure.
- 422: an empty playlist cannot form a queue, or a track could not be resolved,
  depending on the endpoint.
- 500: a storage or other server failure; surface an actionable error. An
  explicitly handled storage failure returns a JSON `error` field.
- Timeout, DNS, TLS, CORS, or connection errors: a response may not exist and
  the operation's outcome can be uncertain. Do not report success.

Do not treat error-message text as a stable error code or display credentials
or signed audio URLs in error messages, diagnostics, or analytics.

## Playback flow for an initial client

1. Connect to the configured server and authenticate with
   `GET /api/v1/playlists`. Show the returned playlists and their tracks.
2. Let the user select a playlist and shuffle preference. Create the queue
   via `POST /api/v1/queue`, preserving the returned order and duplicate
   entries. Do not reshuffle locally or modify the saved playlist.
3. For local playback, resolve tracks using `/api/v1/resolve`. For Cast,
   prepare an on-demand queue and use its stream URLs as described above.
4. Connect to a receiver using the chosen platform's Cast sender SDK. Load
   the selected item first, then insert the remaining items in bounded batches.
   Keep the sender open until queue insertion finishes.
5. Once loaded, the receiver may advance without the sender. A newly
   connected client must reconcile the receiver's reported session with any
   server queue; their states can diverge. Do not silently replace an existing
   receiver queue. Decide the desired reconnect UX with the user.

Avoid stale asynchronous actions: cancellation, disconnect, or a newer
playback request should not allow an older resolution to start unwanted
playback. Do not promise retry or recovery while the client is closed: the
server does not monitor the receiver.

## Reliability and current test evidence

The user confirmed that a Nest Mini advanced through a three-WAV receiver
queue with the sender backgrounded and then closed. The user also confirmed
that a single server-resolved YouTube track played. These results do **not**
establish that a multi-track YouTube queue will survive sender closure,
delayed playback, URL expiry, format issues, seeking, or interruptions.

The opt-in [manual Cast harness](tests/manual/cast_queue_harness.html) can
test multiple direct YouTube URLs and an optional delay before loading.
Follow the [manual test instructions](Readme.md#manual-youtube-queue-and-url-age-test)
and record real-device results; the harness uses an unauthenticated
test-only endpoint, not the production client API. Do not use the test
endpoint in a production client. The URL-age test has not yet been confirmed
on the user's device.

On-demand Cast redirects avoid resolving all songs up front, but receiver
compatibility and long-queue playback still require real-device testing.
The browser audio proxy does not refresh its source.

## Client validation checklist

- Test valid and invalid credentials, no playlists, and user isolation.
- Verify playlist order, duplicates, empty playlists, shuffle, queue
  replacement, server restart, and a second client changing the same queue.
- Exercise malformed requests, failed resolution, non-JSON errors, timeouts,
  and a timed-out queue creation. Never log credentials or stream URLs.
- For a web client, test allowed and disallowed CORS origins, preflight,
  HTTPS, and mixed-content behavior. Test native networking separately.
- With a real receiver, test connection, ordered queue playback, status,
  stop, sender closure, reconnection, aged URLs, and network interruption.
  Separate observations from assumptions and note the device and timing.

## Decisions still needed from the user

- Client platform, supported devices, UI, and whether local playback is in
  scope.
- Credential retention and sign-out behavior appropriate to that platform.
- Behavior when resolving or playing a track fails: retry, stop, or skip.
- Reconnect and recovery UX, and any desired repeat or live queue editing.
- How to address direct URL expiry, especially with no client connected.

Do not implement unsupported server APIs or claim untested Cast behavior as
fact. Re-check the current server code before implementing the client.
