import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "./worker.mjs";

const SECRET = "test-only-stage3-signing-secret-32-bytes-minimum";
const NOW_MS = 1_800_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);
const BASE = "https://gateway.example.test/v1/public-image";

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
    url: "https://cdn.gilakomik.id/private/page-1.webp",
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

test("valid ManhwaDesu VVIP ticket serves private no-store bytes and bypasses Cache API", async () => {
  let matchCalls = 0;
  let putCalls = 0;
  let fetchCalls = 0;
  let seenUrl = "";
  const cache = {
    async match() { matchCalls += 1; return null; },
    async put() { putCalls += 1; }
  };
  const response = await handle(new Request(await signedPrivateUrl()), enabled(), {}, {
    now: () => NOW_MS,
    cache,
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      seenUrl = String(url);
      assert.equal(options.redirect, "manual");
      assert.equal(options.method, "GET");
      return imageResponse();
    }
  });
  assert.equal(response.status, 200);
  assert.equal(seenUrl, "https://cdn.gilakomik.id/private/page-1.webp");
  assert.equal(fetchCalls, 1);
  assert.equal(matchCalls, 0, "VVIP bytes must never read shared Cache API");
  assert.equal(putCalls, 0, "VVIP bytes must never write shared Cache API");
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-nexora-cache"), "PRIVATE");
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test("public-style ManhwaDesu ticket remains rejected", async () => {
  let calls = 0;
  const response = await handle(new Request(await signedPrivateUrl({ scope: undefined, private: undefined, sub: undefined })), enabled(), {}, {
    now: () => NOW_MS,
    fetchImpl: async () => { calls += 1; return imageResponse(); }
  });
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test("private ticket is limited to 90 seconds", async () => {
  assert.equal((await handle(new Request(await signedPrivateUrl({ exp: NOW - 1 })), enabled(), {}, { now: () => NOW_MS })).status, 403);
  assert.equal((await handle(new Request(await signedPrivateUrl({ exp: NOW + 91 })), enabled(), {}, { now: () => NOW_MS })).status, 403);
});

test("private target allowlist fails closed", async () => {
  let calls = 0;
  for (const url of [
    "https://evil.example/private.webp",
    "https://gilakomik.id.evil.example/private.webp",
    "http://cdn.gilakomik.id/private.webp",
    "https://127.0.0.1/private.webp",
    "https://user:pass@cdn.gilakomik.id/private.webp"
  ]) {
    const response = await handle(new Request(await signedPrivateUrl({ url })), enabled(), {}, {
      now: () => NOW_MS,
      fetchImpl: async () => { calls += 1; return imageResponse(); }
    });
    assert.equal(response.status, 403, url);
  }
  assert.equal(calls, 0);
});

test("health reports private VVIP edge readiness without enabling R2 VVIP storage", async () => {
  const response = await handle(new Request("https://gateway.example.test/health"), enabled());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.privateVvipImageProxyEnabled, true);
  assert.equal(body.vvip, true);
  assert.equal(body.imageDeliveryEnabled, false);
});
