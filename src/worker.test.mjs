import assert from "node:assert/strict";
import test from "node:test";
import {handle,licensedKey} from "./worker.mjs";
const TEST_SECRET="test-only-not-a-real-secret-for-gateway-hmac";
const svg="https://pilot.example.test/fixture/image.svg";
async function req(url,env={},method="GET"){return handle(new Request(url,{method}),env);}
async function sign(key,exp){
  const e=new TextEncoder();
  const cryptoKey=await crypto.subtle.importKey("raw",e.encode(TEST_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const buffer=await crypto.subtle.sign("HMAC",cryptoKey,e.encode("GET\n"+key+"\n"+exp));
  return Buffer.from(buffer).toString("base64url");
}
function enabled(bucket) {return {ENABLE_IMAGE_DELIVERY:"true",GATEWAY_HMAC_SECRET:TEST_SECRET,IMAGE_BUCKET:bucket};}
test("health and fixture work without secrets and never call external providers",async()=>{
 const h=await req("https://pilot.example.test/health");
 assert.equal(h.status,200);const status=await h.json();
 assert.equal(status.imageDeliveryEnabled,false);assert.equal(status.externalProviders,false);assert.equal(status.vvip,false);assert.equal(status.stage,2);assert.equal(status.staticAssetsEnabled,true);
 const fixture=await req(svg);
 assert.equal(fixture.status,200);assert.match(fixture.headers.get("content-type"),/image\/svg\+xml/);
 assert.match(await fixture.text(),/NEXORA/);
 assert.equal((await req(svg,{},"HEAD")).status,200);
 assert.equal((await req(svg,{},"POST")).status,405);
});
test("private features fail closed even when a random visitor guesses routes",async()=>{
 const url="https://pilot.example.test/v1/image?key=public%2Fa.png&exp=1999999999&sig=bad";
 assert.equal((await req(url)).status,503);
 assert.equal((await req(url,{ENABLE_IMAGE_DELIVERY:"true"})).status,503);
 assert.equal((await req("https://pilot.example.test/secret")).status,404);
 assert.equal(licensedKey("vvip/a.webp"),false);
 for (const k of ["public/../x.png","public//x.jpg","https://evil.test/a.png","public/x.svg","public/x.webp?u=1"])
   assert.equal(licensedKey(k),false,k);
 assert.equal(licensedKey("public/owned/example.webp"),true);
});
test("signature, short expiry, MIME, R2 streaming and size guard",async()=>{
 const calls=[];
 const r2={
   async get(k){calls.push(["get",k]);return {size:8,body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8));controller.close();}})};},
   async head(k){calls.push(["head",k]);return {size:8};}
 };
 const env=enabled(r2),now=Math.floor(Date.now()/1000),key="public/owned/demo.webp",exp=String(now+60);
 const signValue=await sign(key,exp);
 const query="key="+encodeURIComponent(key)+"&exp="+exp+"&sig="+signValue;
 const path="https://pilot.example.test/v1/image?"+query;
 assert.equal((await req(path.replace(signValue,"invalid"),env)).status,400);
 const tampered=path.replace(encodeURIComponent(key),encodeURIComponent("public/other/demo.webp"));
 assert.equal((await req(tampered,env)).status,403);
 assert.equal((await req(path.replace("exp="+exp,"exp="+String(now-1)),env)).status,403);
 assert.equal(calls.length,0,"Rejected signatures must not read storage");
 const success=await req(path,env);
 assert.equal(success.status,200);
 assert.equal(success.headers.get("content-type"),"image/webp");
 assert.match(success.headers.get("cache-control"),/no-store/);
 assert.equal((await success.arrayBuffer()).byteLength,8);
 assert.deepEqual(calls,[["get",key]]);
 const head=await req(path,env,"HEAD");
 assert.equal(head.status,200);
 assert.deepEqual(calls,[["get",key],["head",key]]);
 assert.equal((await head.arrayBuffer()).byteLength,0);
 const oversized={async get(){return {size:8000001,body:new ReadableStream()}}};
 assert.equal((await req(path,enabled(oversized))).status,413);
 const missing={async get(){return null}};
 assert.equal((await req(path,enabled(missing))).status,404);
});
