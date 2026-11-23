import { state } from "./state.js";

export class ApiError extends Error {
  constructor(message, status = 0, uncertain = false) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
  }
}

export async function api(path, { method = "GET", body, signal, auth = state.auth } = {}) {
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; timeout.abort(); }, 30000);
  const abort = () => timeout.abort();
  if (signal) {
    if (signal.aborted) timeout.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  try {
    let response;
    try {
      response = await fetch(auth.base + "/api/v1" + path, {
        method, headers: { Authorization: auth.header, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: timeout.signal,
        redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
      });
    } catch (error) {
      if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError(timedOut ? "The request timed out." : "Network, TLS, CORS, mixed-content, or redirect failure.", 0, method !== "GET");
    }
    if (response.status === 401) throw new ApiError("Authentication failed. Sign in again.", 401);
    if (!response.ok) {
      const descriptions = { 400: "The server rejected the request.", 404: "The requested playlist or queue was not found.", 422: "The playlist is empty or the track could not be resolved.", 500: "The server encountered an error." };
      throw new ApiError(descriptions[response.status] || `Server returned HTTP ${response.status}.`, response.status);
    }
    if (response.status === 204) return null;
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      throw new ApiError("The server returned a non-JSON response.", response.status, method !== "GET");
    }
    try { return await response.json(); }
    catch { throw new ApiError("The server returned invalid JSON.", response.status, method !== "GET"); }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
  }
}

export function requireQueue(result) {
  if (!result || !result.queue || !Array.isArray(result.queue.videos)) throw new ApiError("The server returned an invalid queue.");
  return result.queue;
}

export async function refreshPlaylists(auth = state.auth, signal) {
  const result = await api("/playlists", { auth, signal });
  if (!result || !Array.isArray(result.playlists) || !result.playlists.every(p => typeof p.id === "string" && Array.isArray(p.videos))) {
    throw new ApiError("The server returned an invalid playlist list.");
  }
  return result.playlists;
}
