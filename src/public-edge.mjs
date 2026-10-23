import {
  canonicalCacheRequest,
  decodePublicImageTicket,
  validImageTicketSignature,
  validatePublicTarget
} from "./worker.mjs";
import { providerRequestHeaders } from "./provider-compat.mjs";

const MAX_IMAGE_BYTES = 8_000_000;
const MAX_SIGNATURE_LIFETIME_SECONDS = 300;
const PUBLIC_IMAGE_EDGE_TTL_SECONDS = 3_600;
const PUBLIC_IMAGE_BROWSER_TTL_SECONDS = 300;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex"
    }
  });
}

function secretIsValid(secret) {
  return typeof secret === "string" && new TextEncoder().encode(secret).byteLength >= 32;
}

function publicImageHeaders(contentType, size, cacheStatus) {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${PUBLIC_IMAGE_BROWSER_TTL_SECONDS}, s-maxage=${PUBLIC_IMAGE_EDGE_TTL_SECONDS}`,
    "CDN-Cache-Control": `public, max-age=${PUBLIC_IMAGE_EDGE_TTL_SECONDS}`,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Nexora-Cache": cacheStatus
  };
  if (Number.isSafeInteger(size) && size >= 0) headers["Content-Length"] = String(size);
  return headers;
}

function boundedStream(body, maximumBytes = MAX_IMAGE_BYTES) {
  if (!body || typeof body.getReader !== "function") return null;
  const reader = body.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (size < 1) controller.error(new Error("UPSTREAM_BODY_INVALID"));
          else controller.close();
          return;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        size += chunk.byteLength;
        if (size > maximumBytes) {
          await reader.cancel("BODY_TOO_LARGE").catch(() => {});
          controller.error(new Error("BODY_TOO_LARGE"));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        await reader.cancel("UPSTREAM_READ_FAILED").catch(() => {});
        controller.error(error instanceof Error ? error : new Error("UPSTREAM_READ_FAILED"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    }
  });
}

function safeLog(log, source, status, cache, bytes, started, errorCode, upstreamStatus) {
  const knownSource = ["mangadex", "shinigami", "voratoon", "ainzscans", "mangadotnet"].includes(source);
  const row = {
    event: "public-image-edge",
    source: knownSource ? source : "unknown",
    status: Number(status) || 500,
    cache: cache || "BYPASS",
    bytes: Math.max(0, Number(bytes) || 0),
    latencyMs: Math.max(0, Date.now() - started),
    errorCode: typeof errorCode === "string" ? errorCode : null,
    upstreamStatus: Number.isInteger(Number(upstreamStatus)) ? Number(upstreamStatus) : null
  };
  try { log(JSON.stringify(row)); } catch {}
}

async function handlePublicImageEdge(request, env = {}, context = {}, dependencies = {}) {
  const started = Date.now();
  const log = typeof dependencies.log === "function" ? dependencies.log : console.info;
  let source = "unknown";
  let cacheStatus = "BYPASS";
  let byteSize = 0;
  let response = null;
  let errorCode = null;
  let upstreamStatus = null;

  try {
    const method = String(request?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      errorCode = "METHOD_NOT_ALLOWED";
      return response = responseJson({ ok: false, error: errorCode }, 405);
    }
    if (env.ENABLE_PROVIDER_IMAGE_PROXY !== "true") {
      errorCode = "PROVIDER_IMAGE_PROXY_DISABLED";
      return response = responseJson({ ok: false, error: errorCode }, 503);
    }
    if (!secretIsValid(env.COMIC_GATEWAY_SIGNING_SECRET)) {
      errorCode = "CONFIGURATION_UNAVAILABLE";
      return response = responseJson({ ok: false, error: errorCode }, 503);
    }

    const requestUrl = new URL(request.url);
    const ticket = requestUrl.searchParams.get("ticket") || "";
    const sig = requestUrl.searchParams.get("sig") || "";
    if (!ticket || !sig) {
      errorCode = "INVALID_IMAGE_REQUEST";
      return response = responseJson({ ok: false, error: errorCode }, 400);
    }
    if (!(await validImageTicketSignature(env.COMIC_GATEWAY_SIGNING_SECRET, ticket, sig))) {
      errorCode = "SIGNATURE_INVALID";
      return response = responseJson({ ok: false, error: errorCode }, 403);
    }

    const payload = decodePublicImageTicket(ticket);
    if (!payload || payload.v !== 1 || typeof payload.src !== "string" || typeof payload.url !== "string" || typeof payload.policy !== "string" || !Number.isSafeInteger(payload.exp)) {
      errorCode = "INVALID_IMAGE_TICKET";
      return response = responseJson({ ok: false, error: errorCode }, 400);
    }
    source = payload.src;
    const now = Math.floor((typeof dependencies.now === "function" ? dependencies.now() : Date.now()) / 1000);
    if (payload.exp <= now) {
      errorCode = "SIGNED_URL_EXPIRED";
      return response = responseJson({ ok: false, error: errorCode }, 403);
    }
    if (payload.exp > now + MAX_SIGNATURE_LIFETIME_SECONDS) {
      errorCode = "SIGNED_URL_TOO_LONG";
      return response = responseJson({ ok: false, error: errorCode }, 403);
    }

    const validated = validatePublicTarget(source, payload.url, payload.policy);
    if (!validated) {
      errorCode = "TARGET_NOT_ALLOWED";
      return response = responseJson({ ok: false, error: errorCode }, 403);
    }

    const cache = dependencies.cache || globalThis.caches?.default;
    if (cache) cacheStatus = "MISS";
    const cacheRequest = await canonicalCacheRequest(source, validated.target, validated.policy.id, requestUrl.origin);
    if (cache && typeof cache.match === "function") {
      try {
        const cached = await cache.match(cacheRequest);
        if (cached) {
          cacheStatus = "HIT";
          byteSize = Number(cached.headers.get("content-length")) || 0;
          const headers = new Headers(cached.headers);
          headers.set("X-Nexora-Cache", "HIT");
          response = new Response(method === "HEAD" ? null : cached.body, { status: cached.status, headers });
          return response;
        }
      } catch {
        cacheStatus = "BYPASS";
      }
    }

    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      errorCode = "UPSTREAM_UNAVAILABLE";
      return response = responseJson({ ok: false, error: errorCode }, 503);
    }

    const policyHeaders = source === "shinigami" ? {} : validated.policy.headers;
    const upstreamHeaders = providerRequestHeaders(source, policyHeaders);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let upstream;
    try {
      upstream = await fetchImpl(validated.target.toString(), {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: upstreamHeaders
      });
    } catch {
      errorCode = "UPSTREAM_UNAVAILABLE";
      return response = responseJson({ ok: false, error: errorCode }, 502);
    } finally {
      clearTimeout(timer);
    }

    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      errorCode = "UPSTREAM_REDIRECT_REJECTED";
      upstreamStatus = upstream.status;
      return response = responseJson({ ok: false, error: errorCode }, 502);
    }
    // Observe an actual provider refusal. Do not assume every cold image is
    // challenged, and never fall back to the retired Vercel binary origin.
    if (source === "mangadotnet" && (
      upstream.headers.get("cf-mitigated") === "challenge" ||
      (upstream.status === 403 && /cloudflare|html/i.test(
        `${upstream.headers.get("server") || ""} ${upstream.headers.get("content-type") || ""}`
      ))
    )) {
      await upstream.body?.cancel?.().catch(() => {});
      errorCode = "PROVIDER_CHALLENGE";
      upstreamStatus = upstream.status;
      return response = responseJson({ ok: false, error: errorCode }, 503);
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      if (source === "mangadotnet" && upstream.status === 403) {
        await upstream.body?.cancel?.().catch(() => {});
        errorCode = "PROVIDER_ACCESS_DENIED";
        upstreamStatus = 403;
        return response = responseJson({ ok: false, error: errorCode, upstreamStatus, retryable: false }, 503);
      }
      errorCode = "UPSTREAM_FAILED";
      upstreamStatus = upstream.status;
      return response = responseJson({ ok: false, error: errorCode }, upstream.status === 404 ? 404 : 502);
    }

    const contentType = String(upstream.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(contentType)) {
      errorCode = "IMAGE_TYPE_INVALID";
      upstreamStatus = upstream.status;
      return response = responseJson({ ok: false, error: errorCode }, 415);
    }
    const declaredLength = String(upstream.headers.get("content-length") || "").trim();
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) < 1 || Number(declaredLength) > MAX_IMAGE_BYTES)) {
      errorCode = "IMAGE_SIZE_INVALID";
      upstreamStatus = upstream.status;
      return response = responseJson({ ok: false, error: errorCode }, 413);
    }

    if (method === "HEAD") {
      byteSize = declaredLength ? Number(declaredLength) : 0;
      response = new Response(null, { status: 200, headers: publicImageHeaders(contentType, declaredLength ? byteSize : null, "MISS") });
      return response;
    }

    const body = boundedStream(upstream.body);
    if (!body) {
      errorCode = "UPSTREAM_BODY_INVALID";
      upstreamStatus = upstream.status;
      return response = responseJson({ ok: false, error: errorCode }, 502);
    }

    byteSize = declaredLength ? Number(declaredLength) : 0;
    const headers = publicImageHeaders(contentType, declaredLength ? byteSize : null, "MISS");
    response = new Response(body, { status: 200, headers });

    const hasSetCookie = Boolean(upstream.headers.get("set-cookie"));
    if (cache && !hasSetCookie && typeof cache.put === "function") {
      const put = cache.put(cacheRequest, response.clone()).catch(() => {});
      if (context && typeof context.waitUntil === "function") context.waitUntil(put);
      else void put;
    }
    return response;
  } catch {
    errorCode = "GATEWAY_FAILED";
    return response = responseJson({ ok: false, error: errorCode }, 500);
  } finally {
    safeLog(log, source, response?.status || 500, cacheStatus, byteSize, started, errorCode, upstreamStatus);
  }
}

export {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_SIGNATURE_LIFETIME_SECONDS,
  boundedStream,
  handlePublicImageEdge,
  publicImageHeaders
};
