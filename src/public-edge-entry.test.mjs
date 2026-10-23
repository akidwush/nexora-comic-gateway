import assert from "node:assert/strict";
import test from "node:test";
import { handlePublicImageEdge } from "./public-edge.mjs";

const TEST_SECRET = "test-only-stage3-signing-secret-32-bytes-minimum";
const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);
const BASE = "https://gateway.example.test/v1/public-image";
const POLICIES = {
  mangadex: "mangadex-v1",
  shinigami: "shinigami-v1",
  voratoon: "voratoon-v1",
  ainzscans: "ainzscans-v1",
  mangadotnet: "mangadotnet-v1"
};

function encode(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function signature(ticket) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ticket))).toString("base64url");
}

async function signedUrl(source, url, exp = NOW + 240) {
  const ticket = encode({ v: 1, src: source, url, exp, policy: POLICIES[source] });
  return `${BASE}?ticket=${encodeURIComponent(ticket)}&sig=${await signature(ticket)}`;
}

function enabled() {
  return {
    ENABLE_PROVIDER_IMAGE_PROXY: "true",
    COMIC_GATEWAY_SIGNING_SECRET: TEST_SECRET
  };
}

function missCache() {
  return {
    puts: 0,
    async match() { return null; },
    async put() { this.puts += 1; }
  };
}

test("Shinigami public edge uses current image headers and never stale Referer/Origin", async () => {
  let seen = null;
  const url = await signedUrl("shinigami", "https://cdn.shngm.io/chapter/page-01.webp");
  const response = await handlePublicImageEdge(new Request(url), enabled(), {}, {
    now: () => NOW_MS,
    fetchImpl: async (input, options) => {
      seen = { input: String(input), options };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/webp", "Content-Length": "3" }
      });
    }
  });

  assert.equal(response.status, 200);
  assert.equal(await response.arrayBuffer().then((value) => value.byteLength), 3);
  assert.equal(seen.input, "https://cdn.shngm.io/chapter/page-01.webp");
  const headers = new Headers(seen.options.headers);
  assert.equal(headers.get("referer"), null);
  assert.equal(headers.get("origin"), null);
  assert.equal(headers.get("dnt"), "1");
  assert.equal(headers.get("sec-gpc"), "1");
  assert.equal(headers.get("sec-fetch-dest"), "empty");
  assert.equal(headers.get("accept"), "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
});

test("public edge returns before the whole upstream image is buffered", async () => {
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([10, 11]));
      secondGate.then(() => {
        controller.enqueue(new Uint8Array([12, 13]));
        controller.close();
      });
    }
  });

  const url = await signedUrl("mangadex", "https://uploads.mangadex.org/data/hash/page.webp");
  const handler = handlePublicImageEdge(new Request(url), enabled(), {}, {
    now: () => NOW_MS,
    fetchImpl: async () => new Response(upstreamBody, { status: 200, headers: { "Content-Type": "image/webp" } })
  });

  const response = await Promise.race([
    handler,
    new Promise((_, reject) => setTimeout(() => reject(new Error("handler waited for full body")), 100))
  ]);
  assert.equal(response.status, 200);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual([...first.value], [10, 11]);

  releaseSecond();
  const second = await reader.read();
  assert.equal(second.done, false);
  assert.deepEqual([...second.value], [12, 13]);
  const done = await reader.read();
  assert.equal(done.done, true);
});

test("declared oversized public image is rejected before body delivery", async () => {
  const url = await signedUrl("mangadex", "https://uploads.mangadex.org/data/hash/large.webp");
  const response = await handlePublicImageEdge(new Request(url), enabled(), {}, {
    now: () => NOW_MS,
    fetchImpl: async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "Content-Type": "image/webp", "Content-Length": "8000001" }
    })
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: "IMAGE_SIZE_INVALID" });
});

test("MangaDotNet cold image fetches its signed allowlisted target at Cloudflare without Vercel", async () => {
  let calls = 0;
  const cache = missCache();
  const url = await signedUrl("mangadotnet", "https://cdn.mangadot.net/pages/page-01.webp");
  const response = await handlePublicImageEdge(new Request(url), enabled(), {}, {
    now: () => NOW_MS,
    cache,
    fetchImpl: async (input, options) => {
      calls += 1;
      assert.equal(input, "https://cdn.mangadot.net/pages/page-01.webp");
      assert.equal(options.headers.Referer, "https://mangadot.net/");
      assert.equal(options.redirect, "manual");
      return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/webp" } });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1]);
  assert.equal(cache.puts, 1);
});

test("MangaDotNet actual challenge fails closed without retry, Vercel fallback or cache write", async () => {
  let calls = 0;
  const cache = missCache();
  const response = await handlePublicImageEdge(new Request(await signedUrl("mangadotnet", "https://cdn.mangadot.net/a.webp")), enabled(), {}, {
    now: () => NOW_MS, cache,
    fetchImpl: async () => { calls++; return new Response("blocked", {status:403,headers:{"cf-mitigated":"challenge","content-type":"text/html"}}); }
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(cache.puts, 0);
  assert.deepEqual(await response.json(), { ok: false, error: "PROVIDER_CHALLENGE" });
});

for (const [label, makeResponse, status] of [
  ["HTML instead of an image", () => new Response("<html>blocked</html>", {headers:{"content-type":"text/html"}}), 415],
  ["upstream failure", () => new Response("failed", {status:502}), 502],
  ["redirect to an arbitrary host", () => new Response(null, {status:302,headers:{location:"https://evil.test/a"}}), 502],
  ["network timeout", () => {throw new DOMException("timeout","AbortError");}, 502]
]) test(`MangaDotNet ${label} is rejected with one request and no cached success`, async () => {
  let calls=0;const cache=missCache();
  const response=await handlePublicImageEdge(new Request(await signedUrl("mangadotnet","https://cdn.mangadot.net/a.webp")),enabled(),{}, {
    now:()=>NOW_MS,cache,fetchImpl:async()=>{calls++;return makeResponse();}
  });
  assert.equal(response.status,status);assert.equal(calls,1);assert.equal(cache.puts,0);
});

test("MangaDotNet existing Cloudflare cache hit remains readable with zero network fetch", async () => {
  let calls = 0;
  const cached = new Response(new Uint8Array([7, 8, 9]), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": "3",
      "Cache-Control": "public, max-age=300",
      "X-Nexora-Cache": "MISS"
    }
  });
  const cache = {
    async match() { return cached.clone(); },
    async put() { throw new Error("cache put must not run on HIT"); }
  };
  const url = await signedUrl("mangadotnet", "https://cdn.mangadot.net/pages/page-01.webp");
  const response = await handlePublicImageEdge(new Request(url), enabled(), {}, {
    now: () => NOW_MS,
    cache,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network fetch must not run on HIT");
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-nexora-cache"), "HIT");
  assert.equal(calls, 0);
  assert.equal((await response.arrayBuffer()).byteLength, 3);
});
