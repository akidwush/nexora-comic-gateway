import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker-entry.mjs";
import { createCompatFetch, isMangaDotNetVercelOrigin, normalizeCompatHeaders } from "./entry-helpers.mjs";


test("Shinigami image compatibility drops stale Referer/Origin and uses current image headers", () => {
  const url = new URL("https://cdn.shngm.io/chapter/page-01.webp");
  const headers = normalizeCompatHeaders(url, {
    headers: {
      Accept: "image/webp",
      Referer: "https://app.shinigami.asia/",
      Origin: "https://app.shinigami.asia",
      "User-Agent": "old"
    }
  });

  assert.equal(headers.get("referer"), null);
  assert.equal(headers.get("origin"), null);
  assert.equal(headers.get("dnt"), "1");
  assert.equal(headers.get("sec-gpc"), "1");
  assert.equal(headers.get("sec-fetch-dest"), "empty");
  assert.equal(headers.get("accept"), "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
});


test("Shinigami suffix-confusion hosts do not receive provider compatibility headers", () => {
  const url = new URL("https://cdn.shngm.io.evil.example/page.webp");
  const headers = normalizeCompatHeaders(url, {
    headers: { Referer: "https://keep.example/", Origin: "https://keep.example" }
  });
  assert.equal(headers.get("referer"), "https://keep.example/");
  assert.equal(headers.get("origin"), "https://keep.example");
  assert.equal(headers.get("sec-gpc"), null);
});


test("MangaDotNet Vercel image origin is hard-blocked before network fetch", async () => {
  const target = new URL("https://all-tools-nexora-teal.vercel.app/api/comics?action=mangadotnet-origin");
  assert.equal(isMangaDotNetVercelOrigin(target), true);

  let calls = 0;
  const compatFetch = createCompatFetch(async () => {
    calls += 1;
    return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "image/webp" } });
  });
  const response = await compatFetch(target.toString(), { method: "GET" });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), { ok: false, error: "VERCEL_IMAGE_ORIGIN_DISABLED" });
});


test("unrelated upstream requests pass through without changing request semantics", async () => {
  let seen = null;
  const compatFetch = createCompatFetch(async (input, options) => {
    seen = { input: String(input), options };
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/webp" } });
  });
  const response = await compatFetch("https://uploads.mangadex.org/data/hash/page.webp", {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "image/webp", "X-Test": "1" }
  });
  assert.equal(response.status, 200);
  assert.equal(seen.input, "https://uploads.mangadex.org/data/hash/page.webp");
  assert.equal(seen.options.method, "GET");
  assert.equal(seen.options.redirect, "manual");
  assert.equal(seen.options.headers.get("x-test"), "1");
  assert.equal(seen.options.headers.get("accept"), "image/webp");
});


test("entrypoint exposes a non-secret deploy revision header", async () => {
  const response = await worker.fetch(new Request("https://gateway.example.test/health"), {
    ENABLE_PROVIDER_IMAGE_PROXY: "false"
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-nexora-gateway-revision"), "comic-images-v2");
  const payload = await response.json();
  assert.equal(payload.ok, true);
});
