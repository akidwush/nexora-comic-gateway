import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "./worker.mjs";

const SECRET = "test-only-stage3-signing-secret-32-bytes-minimum";
const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);
const BASE = "https://gateway.example.test/v1/private-image";

function encode(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
async function signature(ticket) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ticket))).toString("base64url");
}
async function signedPrivateUrl(overrides = {}) {
  const payload = {
    v: 1,
    src: "manhwadesu",
    rid: "chapter-1",
    idx: 0,
    exp: NOW + 90,
    policy: "manhwadesu-vvip-v1",
    scope: "vvip",
    private: true,
    sub: "abcdefghijklmnopqrstuv",
    ...overrides
  };
  const ticket = encode(payload);
  return `${BASE}?ticket=${encodeURIComponent(ticket)}&sig=${await signature(ticket)}`;
}
function enabled() {
  return { ENABLE_PROVIDER_IMAGE_PROXY: "true", COMIC_GATEWAY_SIGNING_SECRET: SECRET };
}
function imageResponse() {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "Content-Type": "image/webp", "Content-Length": "4" }
  });
}
function metadataResponse(imageUrl = "https://cdn.gilakomik.id/private/page-1.webp") {
  return new Response(JSON.stringify({ data: { images: [imageUrl] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("valid ManhwaDesu VVIP ticket resolves server-side then serves private no-store bytes without Cache API", async () => {
  let matchCalls = 0;
  let putCalls = 0;
  const seen = [];
  const cache = {
    async match() { matchCalls += 1; return null; },
    async put() { putCalls += 1; }
  };
  const url = await signedPrivateUrl();
  const decodedTicket = Buffer.from(new URL(url).searchParams.get("ticket"), "base64url").toString("utf8");
  assert.doesNotMatch(decodedTicket, /https?:\/\/|gilakomik|manhwadesu\.wiki/i, "ticket must not expose the private upstream URL");

  const response = await handle(new Request(url), enabled(), {}, {
    now: () => NOW_MS,
    cache,
    fetchImpl: async (input, options) => {
      const current = new URL(input);
      seen.push(current.toString());
      assert.equal(options.redirect, "manual");
      assert.equal(options.method, "GET");
      if (current.hostname === "api-md.gilakomik.id") {
        assert.equal(current.pathname, "/api/manga/chapter/chapter-1");
        return metadataResponse();
      }
      assert.equal(current.toString(), "https://cdn.gilakomik.id/private/page-1.webp");
      assert.equal(options.headers.Referer, undefined, "working page image request headers stay unchanged");
      assert.equal(options.headers.Origin, undefined);
      return imageResponse();
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [
    "https://api-md.gilakomik.id/api/manga/chapter/chapter-1",
    "https://cdn.gilakomik.id/private/page-1.webp"
  ]);
  assert.equal(matchCalls, 0, "VVIP bytes must never read shared Cache API");
  assert.equal(putCalls, 0, "VVIP bytes must never write shared Cache API");
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-nexora-cache"), "PRIVATE");
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test("public endpoint still rejects ManhwaDesu and private endpoint requires private claims", async () => {
  let calls = 0;
  const privateUrl = await signedPrivateUrl();
  const parsed = new URL(privateUrl);
  parsed.pathname = "/v1/public-image";
  assert.equal((await handle(new Request(parsed), enabled(), {}, {
    now: () => NOW_MS,
    fetchImpl: async () => { calls += 1; return imageResponse(); }
  })).status, 400, "public route expects a public URL-bearing ticket and must not accept private ticket shape");

  const missingClaims = await signedPrivateUrl({ scope: undefined, private: undefined, sub: undefined });
  const response = await handle(new Request(missingClaims), enabled(), {}, {
    now: () => NOW_MS,
    fetchImpl: async () => { calls += 1; return imageResponse(); }
  });
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test("private ticket is limited to 90 seconds and rejects URL-bearing payloads", async () => {
  assert.equal((await handle(new Request(await signedPrivateUrl({ exp: NOW - 1 })), enabled(), {}, { now: () => NOW_MS })).status, 403);
  assert.equal((await handle(new Request(await signedPrivateUrl({ exp: NOW + 91 })), enabled(), {}, { now: () => NOW_MS })).status, 403);
  assert.equal((await handle(new Request(await signedPrivateUrl({ url: "https://cdn.gilakomik.id/private/page-1.webp" })), enabled(), {}, { now: () => NOW_MS })).status, 403);
});

test("private resource identifiers fail closed before provider metadata fetch", async () => {
  let calls = 0;
  for (const overrides of [
    { rid: "../evil" },
    { rid: "" },
    { idx: -1 },
    { idx: 401 },
    { idx: 1.5 }
  ]) {
    const response = await handle(new Request(await signedPrivateUrl(overrides)), enabled(), {}, {
      now: () => NOW_MS,
      fetchImpl: async () => { calls += 1; return metadataResponse(); }
    });
    assert.equal(response.status, 403, JSON.stringify(overrides));
  }
  assert.equal(calls, 0);
});

test("resolved private target allowlist fails closed", async () => {
  for (const imageUrl of [
    "https://evil.example/private.webp",
    "https://gilakomik.id.evil.example/private.webp",
    "http://cdn.gilakomik.id/private.webp",
    "https://127.0.0.1/private.webp",
    "https://user:pass@cdn.gilakomik.id/private.webp"
  ]) {
    let imageFetches = 0;
    const response = await handle(new Request(await signedPrivateUrl()), enabled(), {}, {
      now: () => NOW_MS,
      fetchImpl: async input => {
        const current = new URL(input);
        if (current.hostname === "api-md.gilakomik.id") return metadataResponse(imageUrl);
        imageFetches += 1;
        return imageResponse();
      }
    });
    assert.equal(response.status, 403, imageUrl);
    assert.equal(imageFetches, 0, imageUrl);
  }
});

test("metadata redirects, oversized metadata, missing page, and malformed JSON fail closed", async () => {
  const cases = [
    async () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
    async () => new Response(new Uint8Array(2_000_001), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => new Response(JSON.stringify({ data: { images: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } })
  ];
  for (const fetchImpl of cases) {
    const response = await handle(new Request(await signedPrivateUrl()), enabled(), {}, { now: () => NOW_MS, fetchImpl });
    assert.ok(response.status >= 400);
  }
});

test("health reports private VVIP edge readiness without enabling R2 VVIP storage", async () => {
  const response = await handle(new Request("https://gateway.example.test/health"), enabled());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.privateVvipImageProxyEnabled, true);
  assert.equal(body.vvip, true);
  assert.equal(body.imageDeliveryEnabled, false);
});

test("private cover resolves the manga thumbnail by signed ID with no shared cache or URL in ticket", async () => {
  const url=await signedPrivateUrl({rid:"komik-uji",kind:"cover"});
  const seen=[];
  const response=await handle(new Request(url),enabled(),{}, {
    now:()=>NOW_MS,
    cache:{match(){throw new Error("private cache read");},put(){throw new Error("private cache write");}},
    fetchImpl:async(input,options)=>{
      seen.push(input);assert.equal(options.redirect,"manual");
      if(seen.length===1){assert.equal(input,"https://api-md.gilakomik.id/api/manga/komik-uji");return Response.json({data:{thumbnail:"https://manhwadesu.wiki/wp-content/uploads/cover.webp"}});}
      assert.equal(input,"https://manhwadesu.wiki/wp-content/uploads/cover.webp");
      assert.equal(options.headers.Referer,"https://manhwadesu.wiki/");return imageResponse();
    }
  });
  assert.equal(response.status,200);assert.match(response.headers.get("cache-control"),/private, no-store/);
  assert.equal((await response.arrayBuffer()).byteLength,4);assert.equal(seen.length,2);
});

for(const overrides of [{kind:"other"},{kind:"cover",idx:1},{kind:"cover",url:"https://evil.test/a"}])test(`invalid private cover claims rejected: ${JSON.stringify(overrides)}`,async()=>{
  let calls=0;const response=await handle(new Request(await signedPrivateUrl(overrides)),enabled(),{}, {now:()=>NOW_MS,fetchImpl:async()=>{calls++;throw new Error("not allowed");}});
  assert.equal(response.status,403);assert.equal(calls,0);
});

test("private cover rejects hostile thumbnail and malformed metadata without image request",async()=>{
  for(const metadata of [{data:{thumbnail:"https://evil.test/a.webp"}},{data:{thumbnail:"https://manhwadesu.wiki.evil.test/a.webp"}},{data:{}}]){
    let calls=0;const response=await handle(new Request(await signedPrivateUrl({kind:"cover"})),enabled(),{}, {now:()=>NOW_MS,fetchImpl:async()=>{calls++;return Response.json(metadata);}});
    assert.ok([403,404].includes(response.status));assert.equal(calls,1);
  }
});
