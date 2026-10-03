// NEXORA V1 Comic Gateway.
// Stage 2 static/R2 behavior remains isolated from the Stage 3 public provider proxy.
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_SIGNATURE_LIFETIME_SECONDS = 300;
const PUBLIC_IMAGE_EDGE_TTL_SECONDS = 3_600;
const PUBLIC_IMAGE_BROWSER_TTL_SECONDS = 300;
const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 280" role="img" aria-label="NEXORA Cloudflare pilot"><defs><linearGradient id="g"><stop stop-color="#2547b0"/><stop offset="1" stop-color="#12b9a8"/></linearGradient></defs><rect width="480" height="280" rx="24" fill="url(#g)"/><text x="240" y="131" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="bold" font-size="34">NEXORA</text><text x="240" y="171" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">Cloudflare gateway pilot</text></svg>';
const MIME = Object.freeze({png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",avif:"image/avif"});
const ALLOWED_IMAGE_MIME = new Set(Object.values(MIME));
const EXCLUDED_SOURCES = new Set(["manhwadesu", "doujindesu", "manhwaland"]);
const PUBLIC_PROVIDER_POLICIES = Object.freeze({
  mangadex: Object.freeze({id:"mangadex-v1",hosts:[".mangadex.network", ".mangadex.org"],headers:Object.freeze({})}),
  shinigami: Object.freeze({id:"shinigami-v1",hosts:[".shngm.io", ".shngm.id", ".shinigami.asia"],headers:Object.freeze({Referer:"https://app.shinigami.asia/",Origin:"https://app.shinigami.asia"})}),
  voratoon: Object.freeze({id:"voratoon-v1",hosts:[".voratoon.com"],headers:Object.freeze({Referer:"https://v2.voratoon.com/",Origin:"https://v2.voratoon.com"})}),
  ainzscans: Object.freeze({id:"ainzscans-v1",hosts:[".ainzscans01.com"],headers:Object.freeze({})}),
  mangadotnet: Object.freeze({id:"mangadotnet-v1",hosts:["mangadot.net"],headers:Object.freeze({Referer:"https://mangadot.net/",Origin:"https://mangadot.net"})})
});

function responseJson(data,status=200,extras={}) {
  return new Response(JSON.stringify(data),{
    status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex",...extras}
  });
}
function base64UrlToBytes(value, expectedLength=0) {
  if(typeof value!=="string"||value.length<1||value.length>8192||!/^[A-Za-z0-9_-]+$/.test(value))return null;
  try {
    const padding="=".repeat((4-(value.length%4))%4);
    const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/")+padding);
    if(expectedLength&&raw.length!==expectedLength)return null;
    return Uint8Array.from(raw,c=>c.charCodeAt(0));
  } catch {return null;}
}
function bytesToBase64Url(bytes) {
  let raw="";
  for(const byte of bytes)raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function secretIsValid(secret) {
  return typeof secret==="string"&&new TextEncoder().encode(secret).byteLength>=32;
}
async function validSignature(secret,key,exp,sig) {
  const bytes=base64UrlToBytes(sig,32);
  if(!bytes||!secretIsValid(secret))return false;
  const encoder=new TextEncoder();
  const hmacKey=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  return crypto.subtle.verify("HMAC",hmacKey,bytes,encoder.encode("GET\n"+key+"\n"+exp));
}
async function validPublicImageSignature(secret,ticket,sig) {
  const signature=base64UrlToBytes(sig,32);
  if(!signature||!secretIsValid(secret)||typeof ticket!=="string"||ticket.length>6000)return false;
  const encoder=new TextEncoder();
  const hmacKey=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  return crypto.subtle.verify("HMAC",hmacKey,signature,encoder.encode(ticket));
}
function decodePublicImageTicket(ticket) {
  const bytes=base64UrlToBytes(ticket);
  if(!bytes||bytes.byteLength>4096)return null;
  try {
    const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    return payload&&typeof payload==="object"&&!Array.isArray(payload)?payload:null;
  } catch {return null;}
}
function licensedKey(value) {
  return typeof value==="string"
    && value.length<=180
    && /^public\/[A-Za-z0-9][A-Za-z0-9/_-]{0,155}\.(?:png|jpg|jpeg|webp|avif)$/i.test(value)
    && !value.includes("//");
}
function imageHeaders(key,size) {
  return {
    "Content-Type":MIME[key.split(".").pop().toLowerCase()],
    "Content-Length":String(size),
    "Cache-Control":"private, no-store, max-age=0",
    "CDN-Cache-Control":"no-store",
    "Vercel-CDN-Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff",
    "X-Robots-Tag":"noindex"
  };
}
function hostnameAllowed(hostname,suffixes) {
  const host=String(hostname||"").toLowerCase();
  return suffixes.some(suffix=>{
    const value=String(suffix).toLowerCase();
    return value.startsWith(".")?host===value.slice(1)||host.endsWith(value):host===value||host.endsWith("."+value);
  });
}
function isIpLiteral(hostname) {
  const host=String(hostname||"").replace(/^\[|\]$/g,"");
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)||host.includes(":");
}
function validatePublicTarget(source,value,policyId) {
  if(EXCLUDED_SOURCES.has(source))return null;
  const policy=PUBLIC_PROVIDER_POLICIES[source];
  if(!policy||policy.id!==policyId||typeof value!=="string"||value.length>4000)return null;
  try {
    const target=new URL(value);
    if(target.protocol!=="https:"||target.username||target.password||target.port||target.hash||isIpLiteral(target.hostname))return null;
    if(!hostnameAllowed(target.hostname,policy.hosts))return null;
    return {target,policy};
  } catch {return null;}
}
async function canonicalCacheRequest(source,target,policyId,origin="https://cache.nexora.invalid") {
  const bytes=new TextEncoder().encode(source+"\n"+target.toString()+"\n"+policyId);
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return new Request(new URL("/.nexora-cache/public-image/"+bytesToBase64Url(digest),origin).toString(),{method:"GET"});
}
function publicImageHeaders(contentType,size,cacheStatus) {
  const headers={
    "Content-Type":contentType,
    "Cache-Control":`public, max-age=${PUBLIC_IMAGE_BROWSER_TTL_SECONDS}, s-maxage=${PUBLIC_IMAGE_EDGE_TTL_SECONDS}`,
    "CDN-Cache-Control":`public, max-age=${PUBLIC_IMAGE_EDGE_TTL_SECONDS}`,
    "X-Content-Type-Options":"nosniff",
    "X-Robots-Tag":"noindex",
    "Cross-Origin-Resource-Policy":"cross-origin",
    "X-Nexora-Cache":cacheStatus
  };
  if(Number.isSafeInteger(size)&&size>=0)headers["Content-Length"]=String(size);
  return headers;
}
async function readBoundedBody(response,maximumBytes=MAX_IMAGE_BYTES) {
  if(!response.body||typeof response.body.getReader!=="function")throw Object.assign(new Error("UPSTREAM_BODY_INVALID"),{status:502,code:"UPSTREAM_BODY_INVALID"});
  const reader=response.body.getReader();
  const chunks=[];
  let size=0;
  try {
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      const chunk=value instanceof Uint8Array?value:new Uint8Array(value);
      size+=chunk.byteLength;
      if(size>maximumBytes){await reader.cancel("IMAGE_TOO_LARGE").catch(()=>{});throw Object.assign(new Error("IMAGE_TOO_LARGE"),{status:413,code:"IMAGE_TOO_LARGE"});}
      chunks.push(chunk);
    }
  } catch(error) {
    if(error?.code)throw error;
    await reader.cancel("UPSTREAM_READ_FAILED").catch(()=>{});
    throw Object.assign(new Error("UPSTREAM_READ_FAILED"),{status:502,code:"UPSTREAM_READ_FAILED"});
  }
  if(size<1)throw Object.assign(new Error("UPSTREAM_BODY_INVALID"),{status:502,code:"UPSTREAM_BODY_INVALID"});
  const body=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return body;
}
function safeLog(log,source,status,cache,bytes,started) {
  const row={event:"public-image",source:PUBLIC_PROVIDER_POLICIES[source]?source:"unknown",status:Number(status)||500,cache:cache||"BYPASS",bytes:Math.max(0,Number(bytes)||0),latencyMs:Math.max(0,Date.now()-started)};
  try {log(JSON.stringify(row));} catch {}
}
async function handlePublicImage(request,env,context={},dependencies={}) {
  const started=Date.now();
  const log=typeof dependencies.log==="function"?dependencies.log:console.info;
  let source="unknown",cacheStatus="BYPASS",byteSize=0,response;
  try {
    if(env.ENABLE_PROVIDER_IMAGE_PROXY!=="true")return response=responseJson({ok:false,error:"PROVIDER_IMAGE_PROXY_DISABLED"},503);
    if(!secretIsValid(env.COMIC_GATEWAY_SIGNING_SECRET))return response=responseJson({ok:false,error:"CONFIGURATION_UNAVAILABLE"},503);
    const requestUrl=new URL(request.url);
    const ticket=requestUrl.searchParams.get("ticket");
    const sig=requestUrl.searchParams.get("sig");
    if(!ticket||!sig||!base64UrlToBytes(sig,32))return response=responseJson({ok:false,error:"INVALID_IMAGE_REQUEST"},400);
    // Verify the exact encoded payload before parsing or using any of its fields.
    if(!(await validPublicImageSignature(env.COMIC_GATEWAY_SIGNING_SECRET,ticket,sig)))return response=responseJson({ok:false,error:"SIGNATURE_INVALID"},403);
    const payload=decodePublicImageTicket(ticket);
    if(!payload||payload.v!==1||typeof payload.src!=="string"||typeof payload.url!=="string"||typeof payload.policy!=="string"||!Number.isSafeInteger(payload.exp))
      return response=responseJson({ok:false,error:"INVALID_IMAGE_TICKET"},400);
    source=payload.src;
    const now=Math.floor((typeof dependencies.now==="function"?dependencies.now():Date.now())/1000);
    if(payload.exp<=now)return response=responseJson({ok:false,error:"SIGNED_URL_EXPIRED"},403);
    if(payload.exp>now+MAX_SIGNATURE_LIFETIME_SECONDS)return response=responseJson({ok:false,error:"SIGNED_URL_TOO_LONG"},403);
    if(EXCLUDED_SOURCES.has(source))return response=responseJson({ok:false,error:"SOURCE_NOT_ALLOWED"},403);
    const validated=validatePublicTarget(source,payload.url,payload.policy);
    if(!validated)return response=responseJson({ok:false,error:"TARGET_NOT_ALLOWED"},403);

    const cache=dependencies.cache||globalThis.caches?.default;
    if(cache)cacheStatus="MISS";
    const cacheRequest=await canonicalCacheRequest(source,validated.target,validated.policy.id,requestUrl.origin);
    if(cache&&typeof cache.match==="function"){
      try {
        const cached=await cache.match(cacheRequest);
        if(cached){
          cacheStatus="HIT";
          byteSize=Number(cached.headers.get("content-length"))||0;
          const headers=new Headers(cached.headers);headers.set("X-Nexora-Cache","HIT");
          response=new Response(request.method==="HEAD"?null:cached.body,{status:cached.status,headers});
          return response;
        }
      } catch {cacheStatus="BYPASS";}
    }

    const fetchImpl=dependencies.fetchImpl||globalThis.fetch;
    if(typeof fetchImpl!=="function")return response=responseJson({ok:false,error:"UPSTREAM_UNAVAILABLE"},503);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),20_000);
    let upstream;
    try {
      upstream=await fetchImpl(validated.target.toString(),{
        method:request.method,
        redirect:"manual",
        signal:controller.signal,
        headers:{Accept:"image/avif,image/webp,image/png,image/jpeg","User-Agent":"NEXORA-Comic-Gateway/1.0",...validated.policy.headers}
      });
    } catch {
      return response=responseJson({ok:false,error:"UPSTREAM_UNAVAILABLE"},502);
    } finally {clearTimeout(timer);}
    if(upstream.type==="opaqueredirect"||(upstream.status>=300&&upstream.status<400))return response=responseJson({ok:false,error:"UPSTREAM_REDIRECT_REJECTED"},502);
    if(upstream.status<200||upstream.status>=300)return response=responseJson({ok:false,error:"UPSTREAM_FAILED"},upstream.status===404?404:502);
    const contentType=String(upstream.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();
    if(!ALLOWED_IMAGE_MIME.has(contentType))return response=responseJson({ok:false,error:"IMAGE_TYPE_INVALID"},415);
    const declaredLength=String(upstream.headers.get("content-length")||"").trim();
    if(declaredLength&&(!/^\d+$/.test(declaredLength)||Number(declaredLength)>MAX_IMAGE_BYTES))return response=responseJson({ok:false,error:"IMAGE_SIZE_INVALID"},413);
    if(request.method==="HEAD"){
      byteSize=declaredLength?Number(declaredLength):0;
      response=new Response(null,{status:200,headers:publicImageHeaders(contentType,declaredLength?byteSize:null,"MISS")});
      return response;
    }
    let body;
    try {body=await readBoundedBody(upstream);}
    catch(error){return response=responseJson({ok:false,error:error?.code||"UPSTREAM_READ_FAILED"},Number(error?.status)||502);}
    byteSize=body.byteLength;
    const headers=publicImageHeaders(contentType,byteSize,"MISS");
    response=new Response(body,{status:200,headers});
    const hasSetCookie=Boolean(upstream.headers.get("set-cookie"));
    if(cache&&!hasSetCookie&&typeof cache.put==="function"){
      const cacheResponse=new Response(body.slice(),{status:200,headers});
      const put=cache.put(cacheRequest,cacheResponse).catch(()=>{});
      if(context&&typeof context.waitUntil==="function")context.waitUntil(put);else await put;
    }
    return response;
  } catch {
    return response=responseJson({ok:false,error:"GATEWAY_FAILED"},500);
  } finally {
    safeLog(log,source,response?.status||500,cacheStatus,byteSize,started);
  }
}
async function handle(request,env={},context={},dependencies={}) {
  const url=new URL(request.url);
  const method=request.method.toUpperCase();
  if(method!=="GET"&&method!=="HEAD")
    return responseJson({ok:false,error:"METHOD_NOT_ALLOWED"},405,{"Allow":"GET, HEAD"});
  if(url.pathname==="/health") {
    const publicImageProxyEnabled=env.ENABLE_PROVIDER_IMAGE_PROXY==="true"&&secretIsValid(env.COMIC_GATEWAY_SIGNING_SECRET);
    const body={ok:true,service:"nexora-comic-gateway-pilot",stage:3,staticAssetsEnabled:true,externalProviders:publicImageProxyEnabled,vvip:false,
      imageDeliveryEnabled:env.ENABLE_IMAGE_DELIVERY==="true" && Boolean(env.IMAGE_BUCKET&&env.GATEWAY_HMAC_SECRET),publicImageProxyEnabled};
    return method==="HEAD"?new Response(null,{status:200,headers:{"Cache-Control":"no-store"}}):responseJson(body);
  }
  if(url.pathname==="/fixture/image.svg") {
    return new Response(method==="HEAD"?null:FIXTURE_SVG,{status:200,headers:{
      "Content-Type":"image/svg+xml; charset=utf-8","Cache-Control":"public, max-age=300",
      "X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; style-src 'none'; sandbox",
      "X-Robots-Tag":"noindex"
    }});
  }
  if(url.pathname==="/v1/public-image")return handlePublicImage(request,env,context,dependencies);
  if(url.pathname!=="/v1/image")return responseJson({ok:false,error:"NOT_FOUND"},404);
  // Fail closed. R2 may contain only files NEXORA owns / has explicit redistribution rights for.
  // This is PUBLIC licensed-content infrastructure only. Never put VVIP files in this bucket.
  if(env.ENABLE_IMAGE_DELIVERY!=="true")return responseJson({ok:false,error:"PILOT_DISABLED"},503);
  if(!env.IMAGE_BUCKET||typeof env.GATEWAY_HMAC_SECRET!=="string"||env.GATEWAY_HMAC_SECRET.length<32)
    return responseJson({ok:false,error:"CONFIGURATION_UNAVAILABLE"},503);
  const key=url.searchParams.get("key");
  const expString=url.searchParams.get("exp");
  const sig=url.searchParams.get("sig");
  if(!licensedKey(key)||!expString||!sig||!/^\d{10}$/.test(expString)||!base64UrlToBytes(sig,32))
    return responseJson({ok:false,error:"INVALID_IMAGE_REQUEST"},400);
  const expires=Number(expString),now=Math.floor(Date.now()/1000);
  if(!Number.isSafeInteger(expires)||expires<=now||expires>now+MAX_SIGNATURE_LIFETIME_SECONDS)
    return responseJson({ok:false,error:"SIGNED_URL_EXPIRED"},403);
  if(!(await validSignature(env.GATEWAY_HMAC_SECRET,key,expString,sig)))
    return responseJson({ok:false,error:"SIGNATURE_INVALID"},403);
  const object=method==="HEAD"?await env.IMAGE_BUCKET.head(key):await env.IMAGE_BUCKET.get(key);
  if(!object)return responseJson({ok:false,error:"IMAGE_NOT_FOUND"},404);
  if(!Number.isSafeInteger(object.size)||object.size<1||object.size>MAX_IMAGE_BYTES)
    return responseJson({ok:false,error:"IMAGE_SIZE_INVALID"},413);
  return new Response(method==="HEAD"?null:object.body,{status:200,headers:imageHeaders(key,object.size)});
}
export default {fetch:handle};
export {PUBLIC_PROVIDER_POLICIES,canonicalCacheRequest,decodePublicImageTicket,handle,handlePublicImage,hostnameAllowed,licensedKey,readBoundedBody,validPublicImageSignature,validSignature,validatePublicTarget};
