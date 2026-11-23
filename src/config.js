import { ApiError } from "./api.js";

export async function configuredServerBase() {
  let value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(new URL("server-url.txt", document.baseURI), {
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal
    });
    if (!response.ok) throw new Error("Configuration request failed.");
    value = (await response.text()).trim();
  } catch {
    throw new ApiError("Could not load the BragiServer configuration. Check the deployment's BRAGI_SERVER_URL.");
  } finally {
    clearTimeout(timer);
  }
  let base;
  try { base = new URL(value); }
  catch { throw new ApiError("Invalid BragiServer configuration. Set BRAGI_SERVER_URL to an HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.href.includes("?") || base.href.includes("#")) {
    throw new ApiError("Invalid BragiServer configuration. Set BRAGI_SERVER_URL to an HTTP or HTTPS URL without credentials, query, or fragment.");
  }
  return base.href.replace(/\/+$/, "");
}
