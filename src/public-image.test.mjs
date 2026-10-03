import assert from "node:assert/strict";
import test from "node:test";
import {handle} from "./worker.mjs";

const TEST_SECRET="test-only-stage3-signing-secret-32-bytes-minimum";
const NOW_MS=1_800_000_000_000;
const NOW=Math.floor(NOW_MS/1000);
const BASE="https://gateway.example.test/v1/public-image";
const POLICIES={mangadex:"mangadex-v1",shinigami:"shinigami-v1",voratoon:"voratoon-v1",ainzscans:"ainzscans-v1",mangadotnet:"mangadotnet-v1"};

function encode(payload){return Buffer.from(JSON.stringify(payload)).toString("base64url");}
async function signature(ticket){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(TEST_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(ticket))).toString("base64url");
}
async function signedUrl(source,url,{exp=NOW+240,policy=POLICIES[source]||"excluded-v1"}={}){
  const ticket=encode({v:1,src:source,url,exp,policy});
  return `${BASE}?ticket=${encodeURIComponent(ticket)}&sig=${await signature(ticket)}`;
}
function imageResponse(bytes=new Uint8Array([1,2,3]),options={}){
  return new Response(bytes,{status:options.status||200,headers:{"Content-Type":options.type||"image/webp",...(options.length===false?{}:{"Content-Length":String(options.length??bytes.byteLength)}),...(options.headers||{})}});
}
function fakeCache(){
  const rows=new Map();let puts=0;
  return {get puts(){return puts;},async match(request){return rows.get(request.url)?.clone()||null;},async put(request,response){puts++;rows.set(request.url,response.clone());}};
}
function enabled(){return {ENABLE_PROVIDER_IMAGE_PROXY:"true",COMIC_GATEWAY_SIGNING_SECRET:TEST_SECRET};}
async function invoke(url,{method="GET",fetchImpl=async()=>imageResponse(),cache=fakeCache(),headers={},logs=[]}={}){
  const response=await handle(new Request(url,{method,headers}),enabled(),{}, {fetchImpl,cache,now:()=>NOW_MS,log:value=>logs.push(value)});
  return {response,cache,logs};
}

test("valid MangaDex ticket, GET/HEAD, cache MISS then canonical HIT",async()=>{
  const cache=fakeCache();let calls=0;
  const firstUrl=await signedUrl("mangadex","https://uploads.mangadex.org/data/hash/001.webp",{exp:NOW+120});
  const first=await invoke(firstUrl,{cache,fetchImpl:async()=>{calls++;return imageResponse();}});
  assert.equal(first.response.status,200);assert.equal(first.response.headers.get("x-nexora-cache"),"MISS");assert.equal(calls,1);
  const secondUrl=await signedUrl("mangadex","https://uploads.mangadex.org/data/hash/001.webp",{exp:NOW+240});
  const second=await invoke(secondUrl,{cache,fetchImpl:async()=>{calls++;return imageResponse();}});
  assert.equal(second.response.status,200);assert.equal(second.response.headers.get("x-nexora-cache"),"HIT");assert.equal(calls,1,"signature and expiry must not enter the cache identity");
  const head=await invoke(secondUrl,{method:"HEAD",cache,fetchImpl:async()=>{calls++;return imageResponse();}});
  assert.equal(head.response.status,200);assert.equal((await head.response.arrayBuffer()).byteLength,0);assert.equal(calls,1);
});

test("tampering source, URL, or expiry invalidates the signature",async()=>{
  const original=await signedUrl("mangadex","https://uploads.mangadex.org/data/hash/a.webp");
  const parsed=new URL(original);const payload=JSON.parse(Buffer.from(parsed.searchParams.get("ticket"),"base64url"));
  for(const change of [
    {src:"ainzscans"},
    {url:"https://cdn.ainzscans01.com/a.webp"},
    {exp:payload.exp+1}
  ]){
    parsed.searchParams.set("ticket",encode({...payload,...change}));
    const {response}=await invoke(parsed.toString());assert.equal(response.status,403);
  }
});

test("expiry is current and limited to five minutes",async()=>{
  assert.equal((await invoke(await signedUrl("mangadex","https://uploads.mangadex.org/a.jpg",{exp:NOW-1}))).response.status,403);
  assert.equal((await invoke(await signedUrl("mangadex","https://uploads.mangadex.org/a.jpg",{exp:NOW+301}))).response.status,403);
});

test("private, experimental, and unknown sources are rejected before fetch",async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return imageResponse();};
  for(const source of ["manhwadesu","doujindesu","manhwaland","unknown"]){
    const {response}=await invoke(await signedUrl(source,"https://uploads.mangadex.org/a.jpg"),{fetchImpl});
    assert.equal(response.status,403,source);
  }
  assert.equal(calls,0);
});

test("target validation rejects protocol, IP, userinfo, port, bad host and suffix confusion",async()=>{
  const targets=[
    "http://uploads.mangadex.org/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://[::1]/a.jpg",
    "https://user:pass@uploads.mangadex.org/a.jpg",
    "https://uploads.mangadex.org:8443/a.jpg",
    "https://evil.example/a.jpg",
    "https://mangadex.org.evil.example/a.jpg"
  ];
  for(const target of targets){
    const {response}=await invoke(await signedUrl("mangadex",target));assert.equal(response.status,403,target);
  }
});

test("redirects, bad MIME, declared oversize, and streamed oversize fail closed",async()=>{
  const url=await signedUrl("mangadex","https://uploads.mangadex.org/a.webp");
  assert.equal((await invoke(url,{fetchImpl:async()=>new Response(null,{status:302,headers:{Location:"https://evil.example/x"}})})).response.status,502);
  assert.equal((await invoke(url,{fetchImpl:async()=>imageResponse(new Uint8Array([1]),{type:"image/svg+xml"})})).response.status,415);
  assert.equal((await invoke(url,{fetchImpl:async()=>imageResponse(new Uint8Array([1]),{length:8_000_001})})).response.status,413);
  const oversizedStream=()=>new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4_000_000));controller.enqueue(new Uint8Array(4_000_000));controller.enqueue(new Uint8Array(1));controller.close();}});
  const missingLength=await invoke(url,{fetchImpl:async()=>new Response(oversizedStream(),{status:200,headers:{"Content-Type":"image/jpeg"}})});
  assert.equal(missingLength.response.status,413);
  const wrongLength=await invoke(url,{fetchImpl:async()=>new Response(oversizedStream(),{status:200,headers:{"Content-Type":"image/jpeg","Content-Length":"1"}})});
  assert.equal(wrongLength.response.status,413);
});

test("provider headers are fixed server-side and browser overrides are ignored",async()=>{
  const seen=[];
  const fetchImpl=async(_url,options)=>{seen.push(options);return imageResponse();};
  const cases=[
    ["shinigami","https://cdn.shngm.io/chapter/a.webp","https://app.shinigami.asia/","https://app.shinigami.asia"],
    ["voratoon","https://cdn.voratoon.com/a.webp","https://v2.voratoon.com/","https://v2.voratoon.com"],
    ["mangadotnet","https://cdn.mangadot.net/a.webp","https://mangadot.net/","https://mangadot.net"],
    ["mangadex","https://uploads.mangadex.org/a.webp",undefined,undefined],
    ["ainzscans","https://cdn.ainzscans01.com/a.webp",undefined,undefined]
  ];
  for(const [source,target,referer,origin] of cases){
    const {response}=await invoke(await signedUrl(source,target),{fetchImpl,headers:{Referer:"https://evil.example/",Origin:"https://evil.example"}});
    assert.equal(response.status,200);
    const options=seen.at(-1);assert.equal(options.headers.Referer,referer);assert.equal(options.headers.Origin,origin);assert.equal(options.redirect,"manual");
  }
});

test("failed responses and Set-Cookie responses never enter Cache API",async()=>{
  const url=await signedUrl("voratoon","https://cdn.voratoon.com/a.jpg");
  for(const status of [403,404,500]){
    const cache=fakeCache();const result=await invoke(url,{cache,fetchImpl:async()=>new Response("no",{status})});
    assert.ok(result.response.status>=400);assert.equal(cache.puts,0,status);
  }
  const cache=fakeCache();
  const result=await invoke(url,{cache,fetchImpl:async()=>imageResponse(new Uint8Array([1]),{headers:{"Set-Cookie":"provider=unsafe"}})});
  assert.equal(result.response.status,200);assert.equal(cache.puts,0);
});

test("feature flag and Stage 2 endpoint remain fail closed",async()=>{
  const publicUrl=await signedUrl("mangadex","https://uploads.mangadex.org/a.jpg");
  assert.equal((await handle(new Request(publicUrl),{ENABLE_PROVIDER_IMAGE_PROXY:"false"})).status,503);
  assert.equal((await handle(new Request("https://gateway.example.test/v1/image"),{})).status,503);
});

test("observability emits safe metadata only",async()=>{
  const logs=[];const url=await signedUrl("ainzscans","https://cdn.ainzscans01.com/a.jpg");
  const {response}=await invoke(url,{logs});assert.equal(response.status,200);assert.equal(logs.length,1);
  assert.match(logs[0],/"source":"ainzscans"/);assert.match(logs[0],/"cache":"MISS"/);
  assert.match(logs[0],/"errorCode":null/);assert.match(logs[0],/"upstreamStatus":null/);
  assert.doesNotMatch(logs[0],/ticket|signature|sig|secret|authorization|cookie/i);
  assert.equal(logs[0].includes(new URL(url).searchParams.get("sig")),false);
});

test("failed public image log includes safe diagnostics without signed request data",async()=>{
  const logs=[];
  const target="https://cdn.mangadot.net/private/chapter-42.webp";
  const url=await signedUrl("mangadotnet",target);
  const {response}=await invoke(url,{logs,fetchImpl:async()=>new Response("forbidden",{status:403})});
  assert.equal(response.status,502);assert.deepEqual(await response.json(),{ok:false,error:"UPSTREAM_FAILED"});assert.equal(logs.length,1);
  const row=JSON.parse(logs[0]);
  assert.equal(row.event,"public-image");assert.equal(row.source,"mangadotnet");assert.equal(row.status,502);
  assert.equal(row.cache,"MISS");assert.equal(row.bytes,0);assert.equal(typeof row.latencyMs,"number");
  assert.equal(row.errorCode,"UPSTREAM_FAILED");assert.equal(row.upstreamStatus,403);
  const parsed=new URL(url);
  for(const sensitive of ["ticket","sig",TEST_SECRET,target,parsed.searchParams.get("ticket"),parsed.searchParams.get("sig")])
    assert.equal(logs[0].includes(sensitive),false,sensitive);
});
