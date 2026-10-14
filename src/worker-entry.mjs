import { handle } from "./worker.mjs";
import { handlePublicImageEdge } from "./public-edge.mjs";
import { providerRequestHeaders } from "./provider-compat.mjs";

const GATEWAY_REVISION = "cloudflare-only-v1";
const SHINIGAMI_HOST_SUFFIXES = Object.freeze([".shngm.io", ".shngm.id", ".shinigami.asia"]);

function hostnameAllowed(hostname, suffixes) {
  const host = String(hostname || "").toLowerCase();
  return suffixes.some((suffix) => {
    const value = String(suffix || "").toLowerCase();
    return value.startsWith(".")
      ? host === value.slice(1) || host.endsWith(value)
      : host === value || host.endsWith(`.${value}`);
  });
}

function isMangaDotNetVercelOrigin(url) {
  return url.pathname === "/api/comics" && url.searchParams.get("action") === "mangadotnet-origin";
}

function normalizeCompatHeaders(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (hostnameAllowed(url.hostname, SHINIGAMI_HOST_SUFFIXES)) {
    headers.delete("referer");
    headers.delete("origin");
    const compatible = providerRequestHeaders("shinigami");
    for (const [name, value] of Object.entries(compatible)) headers.set(name, value);
  }
  return headers;
}

function createCompatFetch(baseFetch = globalThis.fetch) {
  return async function compatFetch(input, options = {}) {
    const url = new URL(String(input));
    if (isMangaDotNetVercelOrigin(url)) {
      return new Response(JSON.stringify({ ok: false, error: "VERCEL_IMAGE_ORIGIN_DISABLED" }), {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store"
        }
      });
    }
    if (typeof baseFetch !== "function") throw new TypeError("fetch unavailable");
    const headers = normalizeCompatHeaders(url, options);
    return baseFetch(input, { ...options, headers });
  };
}

function withRevision(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Nexora-Gateway-Revision", GATEWAY_REVISION);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function fetchEntry(request, env = {}, context = {}) {
  const url = new URL(request.url);
  const response = url.pathname === "/v1/public-image"
    ? await handlePublicImageEdge(request, env, context)
    : await handle(request, env, context, { fetchImpl: createCompatFetch(globalThis.fetch) });
  return withRevision(response);
}

export default { fetch: fetchEntry };
export { GATEWAY_REVISION, SHINIGAMI_HOST_SUFFIXES, createCompatFetch, fetchEntry, hostnameAllowed, isMangaDotNetVercelOrigin, normalizeCompatHeaders, withRevision };
