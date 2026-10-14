import { handle } from "./worker.mjs";
import { providerRequestHeaders } from "./provider-compat.mjs";

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
    // Current Shinigami clients fetch page images without the legacy app.shinigami.asia
    // Referer/Origin pair. Keeping those stale headers can make the image CDN reject
    // an otherwise valid page URL while metadata still returns 200.
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

    // Hard boundary: public MangaDotNet cache misses must not pull image bytes
    // through the Vercel origin. Metadata/challenge handling remains fail-closed.
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

async function fetchEntry(request, env = {}, context = {}) {
  return handle(request, env, context, {
    fetchImpl: createCompatFetch(globalThis.fetch)
  });
}

export default { fetch: fetchEntry };
export { SHINIGAMI_HOST_SUFFIXES, createCompatFetch, fetchEntry, hostnameAllowed, isMangaDotNetVercelOrigin, normalizeCompatHeaders };
