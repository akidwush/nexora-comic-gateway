# NEXORA Comic Gateway — Cloudflare Stage 3

Standalone Cloudflare Worker for NEXORA V1 comic image delivery.

This repository does **not** deploy or modify the NEXORA V1 Vercel project. GitHub Actions run tests, Wrangler dry-runs, and local Worker smoke tests only. Production deployment remains an explicit Cloudflare action.

## Current architecture

1. **Public provider edge** — `/v1/public-image` receives signed HMAC tickets for MangaDex, Shinigami, Voratoon, Ainzscans, and MangaDotNet. Valid public images may use Cloudflare Cache API.
2. **Private VVIP edge** — `/v1/private-image` receives an opaque ManhwaDesu ticket only after NEXORA V1 authenticated an active VVIP account. Private bytes are always `no-store` and never enter public Cache API.
3. **Licensed R2 pilot** — `/v1/image` remains disabled by default and is unrelated to provider/VVIP delivery.

### Hard transport rule

Comic page **bytes must not use Vercel as a fallback transport**.

NEXORA V1 may use Vercel for authenticated metadata/manifest work and for issuing a small signed `307` redirect to this Worker, but public/VVIP image bodies stay on Cloudflare. A retry must mint/refresh an edge ticket; it must not bypass the edge into a Vercel binary response.

MangaDotNet cache misses fetch the signed allowlisted image directly at Cloudflare, using fixed provider headers, bounded image bodies and no automatic retry. Actual upstream challenges fail closed without caching HTML or routing image bytes through Vercel. Existing valid cache hits remain readable. No anti-bot bypass is implemented.

## Public edge behavior

Public tickets sign:

```text
{ v, src, url, exp, policy }
```

The Worker validates HMAC, expiry, HTTPS target, fixed provider policy/host allowlist, redirect behavior, MIME, and an 8,000,000-byte limit. The browser cannot choose an arbitrary upstream host.

The public allowlist is fixed to:

- MangaDex: `.mangadex.network`, `.mangadex.org`
- Shinigami: `.shngm.io`, `.shngm.id`, `.shinigami.asia`
- Voratoon: `.voratoon.com`
- Ainzscans: `.ainzscans01.com`, `yuucdn.com`, `kacu.gmbr.pro`
- MangaDotNet: `mangadot.net`

### Shinigami compatibility

The current Shinigami image request contract no longer uses the stale `https://app.shinigami.asia/` Referer/Origin pair. For Shinigami image hosts the active edge uses the current image Accept header plus `DNT`, `Sec-GPC`, and `sec-fetch-dest`, while removing the stale Referer/Origin headers.

### Streaming

Public cache misses are returned through a bounded streaming response instead of buffering the entire image before sending the first byte. This keeps time-to-first-byte low while retaining the 8 MB limit. Cache population uses a cloned stream via `waitUntil`, so filling Cloudflare Cache API does not delay the client response.

For public cache identity, `caches.default` hashes:

```text
source + "\n" + normalizedUrl + "\n" + fixedPolicyId
```

Signature and expiry do not enter the cache key. Valid public images use a one-hour edge TTL and five-minute browser TTL.

## Private ManhwaDesu VVIP edge

NEXORA V1 performs the VVIP check before issuing a private ticket. The ticket contains chapter/page coordinates and a non-reversible subject hash, not the private upstream image URL.

A valid private request:

1. validates HMAC and private claims;
2. enforces the short ticket lifetime;
3. resolves the chapter only from the fixed ManhwaDesu API;
4. selects the signed page index;
5. validates the resolved image host;
6. fetches with redirects disabled and image MIME/size guards;
7. returns `Cache-Control: private, no-store` and `X-Nexora-Cache: PRIVATE`.

ManhwaDesu remains rejected by the public cached endpoint. DoujinDesu and ManhwaLand remain excluded.

## Health / deployment verification

With the provider proxy enabled and the signing secret configured, `/health` reports Stage 3 readiness. The compatibility entrypoint also adds this non-secret response header:

```text
X-Nexora-Gateway-Revision: comic-provider-live3
```

Use that header after deployment to verify the repaired Worker is actually live rather than relying on browser cache or assumptions.

## Required secret

NEXORA V1 and this Worker must use the same private 32+ byte `COMIC_GATEWAY_SIGNING_SECRET`.

Never commit or log the secret, tickets, signatures, cookies, raw user IDs, or resolved private URLs.

## Safe rollout order

1. Merge the gateway PR only after CI is green.
2. Deploy the updated Worker explicitly.
3. Verify `/health` returns `X-Nexora-Gateway-Revision: comic-provider-live3`.
4. Verify a signed public image request is served by Cloudflare.
5. Then merge/deploy the coordinated NEXORA V1 redirect hardening PR.
6. Confirm normal and retry page requests return Cloudflare redirects and no comic page bytes are served by Vercel.

Do not reverse the Worker/V1 order.

## Local validation

```sh
npm install --no-audit --no-fund
npm run check
npm test
npx wrangler deploy --dry-run
```

The PR workflow also starts Wrangler locally and smoke-tests Stage 3 routes without deploying production.

## Cloudflare Builds configuration

If Cloudflare Builds is connected:

- repository: `akidwush/nexora-comic-gateway`
- production branch: `main`
- project: `nexora-comic-gateway-pilot`
- build: `npm install --no-audit --no-fund && npm run check && npm test`
- deploy: `npx wrangler deploy`

No R2 binding is required for provider or VVIP proxying.

## API surface

| Path | Behavior |
| --- | --- |
| `GET /health` | Health/config snapshot without secrets |
| `GET /fixture/image.svg` | Worker-generated synthetic test image |
| `GET /pilot/comic-page-v1.svg` | Static synthetic fixture |
| `GET /v1/public-image?ticket=...&sig=...` | Signed cached public provider edge |
| `GET /v1/private-image?ticket=...&sig=...` | Opaque no-store ManhwaDesu VVIP edge |
| `GET /v1/image?key=...&exp=...&sig=...` | Licensed-public R2 route; disabled by default |
| Other paths | 404 |

## Rules for future work

- Never route comic image bytes through Vercel as a fallback.
- Never make ManhwaDesu a public cached provider.
- Never put VVIP images into public Cache API/R2.
- Never expose a private provider image URL in a client ticket.
- Keep provider hosts fixed and server-defined.
- Keep ticket lifetimes bounded.
- Keep VVIP authorization in NEXORA V1 before ticket issuance.
- Do not bypass Cloudflare/CAPTCHA protections.
- Do not deploy production automatically from GitHub Actions/ChatGPT without explicit approval.

## Private cover compatibility

V1 cover redirects use `/v1/private-image` with the existing HMAC/private/VVIP/subject/expiry claims and an additional signed `kind: "cover"`. The resource ID is a manga slug, `idx` must be zero, and no upstream URL appears in the ticket. The Worker reads `/api/manga/{slug}` at the fixed ManhwaDesu API, validates its thumbnail against the existing private image allowlist, and returns `private, no-store` bytes without Cache API. Page tickets with no `kind` retain their previous contract. Unknown kinds, bad signatures, expired or non-VVIP claims, hostile thumbnails and redirects are rejected.

Deploy the reviewed gateway revision **before** deploying the matching All Tools Nexora V1 cover changes; older Workers safely reject cover tickets. Neither PR changes secrets, provider permissions, databases or production deployments. This change is verified with offline provider fixtures; live provider availability must be checked separately after network access and deployment approval.

Live provider correction (2026-10-23): the current API returns cover thumbnails at exact host `manhwadesu.run`. This host is accepted only for signed cover tickets; page tickets keep their original allowlist. Cover requests to this host use the verified `.run` site headers. Subdomains and lookalike hosts remain rejected. A read-only live comparison returned 403 PRIVATE_TARGET_NOT_ALLOWED with the previously merged engine and 200 image/jpeg (211834 bytes) with this correction, using a local test signature, not a production user session.
