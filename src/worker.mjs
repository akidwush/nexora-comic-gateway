// NEXORA V1 Comic Gateway pilot: self-authored fixture + optional LICENSED public R2 images.
// External comic providers and VVIP content are deliberately NOT supported.
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_SIGNATURE_LIFETIME_SECONDS = 300;
const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 280" role="img" aria-label="NEXORA Cloudflare pilot"><defs><linearGradient id="g"><stop stop-color="#2547b0"/><stop offset="1" stop-color="#12b9a8"/></linearGradient></defs><rect width="480" height="280" rx="24" fill="url(#g)"/><text x="240" y="131" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="bold" font-size="34">NEXORA</text><text x="240" y="171" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">Cloudflare gateway pilot</text></svg>';
const MIME = Object.freeze({png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",avif:"image/avif"});

function responseJson(data,status=200,extras={}) {
  return new Response(JSON.stringify(data),{
    status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex",...extras}
  });
}
function base64UrlToBytes(s) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  try {
    const raw=atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=");
    if(raw.length!==32)return null;
    return Uint8Array.from(raw,c=>c.charCodeAt(0));
  } catch {return null;}
}
async function validSignature(secret,key,exp,sig) {
  const bytes=base64UrlToBytes(sig);
  if(!bytes)return false;
  const encoder=new TextEncoder();
  const hmacKey=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  return crypto.subtle.verify("HMAC",hmacKey,bytes,encoder.encode("GET\n"+key+"\n"+exp));
}
function licensedKey(value) {
  // No arbitrary source URL, dot-segments, query URLs or private/VVIP prefixes.
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
async function handle(request,env={}) {
  const url=new URL(request.url);
  const method=request.method.toUpperCase();
  if(method!=="GET"&&method!=="HEAD")
    return responseJson({ok:false,error:"METHOD_NOT_ALLOWED"},405,{"Allow":"GET, HEAD"});
  if(url.pathname==="/health") {
    const body={ok:true,service:"nexora-comic-gateway-pilot",stage:2,staticAssetsEnabled:true,externalProviders:false,vvip:false,
      imageDeliveryEnabled:env.ENABLE_IMAGE_DELIVERY==="true" && Boolean(env.IMAGE_BUCKET&&env.GATEWAY_HMAC_SECRET)};
    return method==="HEAD"?new Response(null,{status:200,headers:{"Cache-Control":"no-store"}}):responseJson(body);
  }
  if(url.pathname==="/fixture/image.svg") {
    return new Response(method==="HEAD"?null:FIXTURE_SVG,{status:200,headers:{
      "Content-Type":"image/svg+xml; charset=utf-8","Cache-Control":"public, max-age=300",
      "X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; style-src 'none'; sandbox",
      "X-Robots-Tag":"noindex"
    }});
  }
  if(url.pathname!=="/v1/image")return responseJson({ok:false,error:"NOT_FOUND"},404);
  // Fail closed. R2 may contain only files NEXORA owns / has explicit redistribution rights for.
  // This is PUBLIC licensed-content infrastructure only. Never put VVIP files in this bucket.
  if(env.ENABLE_IMAGE_DELIVERY!=="true")return responseJson({ok:false,error:"PILOT_DISABLED"},503);
  if(!env.IMAGE_BUCKET||typeof env.GATEWAY_HMAC_SECRET!=="string"||env.GATEWAY_HMAC_SECRET.length<32)
    return responseJson({ok:false,error:"CONFIGURATION_UNAVAILABLE"},503);
  const key=url.searchParams.get("key");
  const expString=url.searchParams.get("exp");
  const sig=url.searchParams.get("sig");
  if(!licensedKey(key)||!expString||!sig||!/^\d{10}$/.test(expString)||!base64UrlToBytes(sig))
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
  // Content type comes only from the strict validated suffix, not user or object metadata.
  return new Response(method==="HEAD"?null:object.body,{status:200,headers:imageHeaders(key,object.size)});
}
export default {fetch:handle};
export {handle,licensedKey,validSignature};
