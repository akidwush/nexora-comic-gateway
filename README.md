# NEXORA Comic Gateway — Cloudflare Stage 3

Standalone Cloudflare Worker for NEXORA V1 comic image delivery.

This repository does **not** deploy or modify the NEXORA V1 Vercel project. GitHub Actions in this repository run tests and Wrangler dry-runs only; production deployment remains an explicit Cloudflare action.

## Current architecture

The Worker has three deliberately separate image paths:

1. **Public provider edge** — `/v1/public-image` receives short-lived HMAC tickets for MangaDex, Shinigami, Voratoon, Ainzscans, and MangaDotNet. Valid public images may use Cloudflare Cache API.
2. **Private VVIP edge** — the same endpoint can accept a distinct ManhwaDesu VVIP ticket only after NEXORA V1 has authenticated an active VVIP member and issued that ticket. Private VVIP bytes are never written to or read from Cloudflare Cache API and are returned with `private, no-store` headers.
3. **Licensed R2 pilot** — `/v1/image` remains disabled by default. It is for NEXORA-owned or explicitly redistributable public files only and is not used for VVIP delivery.

The public and private ticket classes intentionally have different policies. ManhwaDesu is still rejected as a **public** provider ticket.

## Security model

### Public provider tickets

Public tickets use HMAC-SHA256 over the complete base64url-encoded JSON payload:

```text
{ v, src, url, exp, policy }
```

The Worker re-derives the provider policy from `src`, validates HTTPS, rejects userinfo/IP/custom-port/suffix-confusion targets, disables upstream redirects, validates image MIME, and bounds image bodies to 8,000,000 bytes. Public tickets expire in at most 300 seconds.

The public allowlist is fixed to:

- MangaDex: `.mangadex.network`, `.mangadex.org`
- Shinigami: `.shngm.io`, `.shngm.id`, `.shinigami.asia`
- Voratoon: `.voratoon.com`
- Ainzscans: `.ainzscans01.com`, `yuucdn.com`, `kacu.gmbr.pro`
- MangaDotNet: `mangadot.net`

MangaDotNet remains the special case: on a canonical Cloudflare cache MISS the Worker uses the signed Vercel origin shield because MangaDotNet can reject direct Worker egress. Cache HIT delivery remains on Cloudflare.

### Private ManhwaDesu VVIP tickets

NEXORA V1 performs the account/VVIP check **before** issuing a private image ticket. The Worker does not independently query the NEXORA membership database.

A private ticket contains:

```text
{
  v: 1,
  src: "manhwadesu",
  url,
  exp,
  policy: "manhwadesu-vvip-v1",
  scope: "vvip",
  private: true,
  sub: "<non-reversible user subject hash>"
}
```

Private tickets:

- expire in at most **90 seconds**;
- are accepted only for ManhwaDesu image hosts `.gilakomik.id` and `.manhwadesu.wiki`;
- require the fixed `manhwadesu-vvip-v1` policy;
- require `scope=vvip`, `private=true`, and a valid hashed subject claim;
- never expose the raw NEXORA user ID;
- never use Cloudflare Cache API;
- return `Cache-Control: private, no-store`, `CDN-Cache-Control: no-store`, and `X-Nexora-Cache: PRIVATE`.

This keeps the normal ManhwaDesu image bytes off Vercel Fast Origin Transfer while retaining VVIP authorization at NEXORA before ticket issuance. A leaked private URL is therefore both signed and very short-lived; it is **not** treated as a replacement for the upstream VVIP authorization step.

DoujinDesu and ManhwaLand remain excluded from this private path.

## Cache behavior

For public providers, `caches.default` uses a canonical hash of:

```text
source + "\n" + normalizedUrl + "\n" + fixedPolicyId
```

The signature and expiry are not part of the public cache identity. Valid public images use a one-hour edge TTL and a five-minute browser TTL. Failed responses, redirects, invalid targets, and upstream responses containing `Set-Cookie` are not cached.

Private VVIP images bypass the Cache API entirely and are always no-store.

## Health endpoint

With `ENABLE_PROVIDER_IMAGE_PROXY=true` and a valid `COMIC_GATEWAY_SIGNING_SECRET`, `/health` reports the provider edge as available, including:

```json
{
  "stage": 3,
  "publicImageProxyEnabled": true,
  "privateVvipImageProxyEnabled": true,
  "vvip": true,
  "imageDeliveryEnabled": false
}
```

`vvip:true` means the **private no-store proxy contract is available**. It does not mean VVIP content is stored in R2 or publicly cached.

## Required secret

Both NEXORA V1 and this Worker must use the same private 32+ byte `COMIC_GATEWAY_SIGNING_SECRET`.

Never commit that value to GitHub, Wrangler vars, documentation, issues, screenshots, or chat. Configure it only as a Cloudflare Worker secret and as the corresponding private NEXORA environment secret.

The non-secret `ENABLE_PROVIDER_IMAGE_PROXY=true` flag is committed in `wrangler.jsonc`. If the signing secret is missing or invalid, the endpoint fails closed.

## Safe deployment order for the VVIP migration

The private VVIP contract changes both repositories, so rollout order matters:

1. Merge this gateway PR after CI succeeds.
2. Manually deploy the updated `nexora-comic-gateway` Worker.
3. Verify `/health` reports `privateVvipImageProxyEnabled:true`.
4. Only then merge/deploy the coordinated NEXORA V1 PR that starts issuing ManhwaDesu private tickets.
5. Test one VVIP chapter and confirm normal page delivery returns `X-Nexora-Cache: PRIVATE` from the Worker rather than binary bytes from Vercel.

Do **not** reverse steps 2 and 4; an older Worker intentionally rejects ManhwaDesu tickets.

## Local validation

```sh
npm install --no-audit --no-fund
npm run check
npm test
npx wrangler deploy --dry-run
```

GitHub Actions performs the same syntax, security unit tests, Wrangler dry-run, and local Worker smoke tests. The workflow does not deploy production.

## Cloudflare repository connection

If the Worker is connected through Cloudflare Builds:

- repository: `akidwush/nexora-comic-gateway`
- production branch: `main`
- project name: `nexora-comic-gateway-pilot`
- build command: `npm install --no-audit --no-fund && npm run check && npm test`
- deploy command: `npx wrangler deploy`
- root directory: repository root

No R2 binding is required for the provider proxy or private VVIP proxy.

## Static Stage 2 fixture

`public/pilot/comic-page-v1.svg` is a synthetic repository-owned test asset served through Cloudflare Static Assets. It is retained only as a deployment/cache fixture. It contains no provider comic imagery.

`ENABLE_IMAGE_DELIVERY` remains `false`; `/v1/image` is unrelated to provider/VVIP proxying.

## API surface

| Path | Behavior |
| --- | --- |
| `GET /health` | Health/config snapshot without secrets |
| `GET /fixture/image.svg` | Worker-generated synthetic test image |
| `GET /pilot/comic-page-v1.svg` | Versioned static test asset |
| `GET /v1/public-image?ticket=...&sig=...` | Signed public-provider proxy or signed no-store ManhwaDesu VVIP proxy, selected by validated ticket class |
| `GET /v1/image?key=...&exp=...&sig=...` | Licensed-public R2 path; disabled unless explicitly enabled |
| Other paths | 404 |

## Rules for future work

- Never make ManhwaDesu a normal public cached provider policy.
- Never put VVIP images into the public Cache API or public R2 bucket.
- Keep provider host allowlists narrow and server-defined.
- Keep public and private ticket TTLs bounded.
- Keep VVIP authorization in NEXORA V1 before private ticket issuance.
- Do not log tickets, signatures, raw user IDs, cookies, secrets, or upstream private URLs.
- Do not deploy automatically from ChatGPT/GitHub Actions without explicit approval.
