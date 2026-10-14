import { handle } from "./worker.mjs";
import { handlePublicImageEdge } from "./public-edge.mjs";
import { createCompatFetch } from "./entry-helpers.mjs";

const GATEWAY_REVISION = "cloudflare-only-v1";

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
