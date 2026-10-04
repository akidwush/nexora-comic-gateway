# NEXORA Comic Gateway — Cloudflare Stage 2 + active signed Stage 3

This repository is the **standalone Cloudflare Worker pilot** for NEXORA V1. It was copied from the tested, isolated stage-one branch of `akidwush/all-tools-nexora`. There are no build scripts or deploy hooks for the NEXORA V1 Vercel production project.

**Scope today:** the original Worker-created SVG fixture, health endpoint, **Cloudflare Static Assets for a repository-owned comic-style test image**, the existing disabled-by-default licensed-public-image R2 handler, and an **enabled signed public-provider image proxy**. The provider proxy accepts only five fixed public sources and their source-specific host allowlists. It has no VVIP membership implementation, rejects ManhwaDesu and all experimental sources, is not an arbitrary URL proxy, and does not require R2. NEXORA V1 sends eligible public pages here first and retains the same-origin Vercel route only as a one-attempt fallback.

## Connect the GitHub repository in Cloudflare

Use your own browser at https://dash.cloudflare.com/ → **Workers & Pages → Create application → Import a repository**.

- Git account: connect your own GitHub account; grant access to **only `akidwush/nexora-comic-gateway`** when prompted.
- Repository: `akidwush/nexora-comic-gateway` (NOT `all-tools-nexora`).
- Project name: `nexora-comic-gateway-pilot` (must match `wrangler.jsonc`).
- Production branch: `main`. All Worker code is now in the repository root.
- Build command: `npm install --no-audit --no-fund && npm run check && npm test`
- Deploy command: `npx wrangler deploy`
- Preview command: leave empty, or use the dashboard default. Do not enable previews for unrelated branches.
- Root directory: leave at repository root if shown. **No R2 bindings or environment secrets are required.**

Review the settings and click **Save and Deploy** only for this new Worker. The GitHub test workflow is intentionally test-only and cannot deploy.

Once deployed after review with `COMIC_GATEWAY_SIGNING_SECRET` configured privately, check `https://<YOUR-SUBDOMAIN>.workers.dev/health` (expect `ok:true`, `stage:3`, `imageDeliveryEnabled:false`, `publicImageProxyEnabled:true`, `vvip:false`) and `https://<YOUR-SUBDOMAIN>.workers.dev/fixture/image.svg`. If the secret is absent or invalid, the public proxy remains fail-closed even though the committed non-secret flag is enabled. Never share Cloudflare account credentials, tokens, cookies, or secrets.

Official docs: https://developers.cloudflare.com/workers/ci-cd/builds/ and https://developers.cloudflare.com/workers/ci-cd/builds/configuration/.

## Local checks and deployment safety

```sh
npm install
npm run check
npm test
npx wrangler deploy --dry-run
```

GitHub Actions repeats the syntax, security-unit-test and Wrangler dry-run steps. It **never** deploys. The Worker is initially safe to deploy as a synthetic-fixture demonstration; it does not receive NEXORA production reader traffic.

## Stage 2 — free static image without R2/payment

- A second synthetic portrait test image lives in `public/pilot/comic-page-v1.svg` and is served from `/pilot/comic-page-v1.svg` as a **static asset**, not as a Worker-generated response. It mimics the length/layout of a mobile comic page but contains no provider or copyrighted comic imagery.
- `wrangler.jsonc` configures `assets.directory=./public`. Reserved `/health`, `/fixture/*`, and `/v1/*` paths **must** run the Worker first. The public `/pilot/*` path is served assets-first without invoking dynamic Worker code.
- `public/_headers` sets an immutable **browser** cache for the versioned `comic-page-v1.svg`. Static assets also benefit from Cloudflare's internal edge caching. `_headers` does not affect Worker responses.
- Add only original, commercially redistributable **public** files to `public/pilot/`. This is unsuitable for third-party comics with unclear distribution rights, VVIP, per-user images, or large, frequently updated libraries. For any changed file, use a new versioned filename.
- **No billing details, R2 bucket, payment methods, secrets or provider credentials are required for Stage 2.**
- After a **single** controlled merge/deployment, open `/health` (expect `stage:2` and `staticAssetsEnabled:true`) then `/pilot/comic-page-v1.svg` on your existing `workers.dev` address. Verify mobile display. Cloudflare's `CF-Cache-Status` is a hint, but may vary by edge and first request; do not infer actual bandwidth savings from it.
- This stage demonstrates a free hosting path for *owned/authorized* public images only; NEXORA V1 production Comic Reader remains unchanged and no savings should yet be claimed.

## Stage 3 — signed public provider images

`GET` and `HEAD /v1/public-image` require an HMAC-SHA256 signature over the complete base64url-encoded JSON ticket. The payload is `{v, src, url, exp, policy}`; modifying the source, upstream URL, expiry, or policy invalidates the signature. Tickets expire in at most five minutes. Base64url is transport encoding, not secrecy.

The Worker verifies the signature before parsing the payload for routing or consulting Cache API. It then re-derives the fixed provider policy from `src`, rejects private/experimental/unknown sources, validates HTTPS/no-userinfo/no-IP/no-custom-port and the exact hostname suffix allowlist, and fetches with redirects disabled. Only JPEG, PNG, WebP, and AVIF bodies up to 8,000,000 bytes are accepted. A bounded stream reader enforces the limit even if `Content-Length` is missing or incorrect.

Provider `Referer` and `Origin` headers are fixed by Worker policy; browser-supplied values and ticket-supplied headers are ignored. Safe logs contain only source, status, cache result, byte size, and latency.

After validation, `caches.default` uses `sha256(source + "\\n" + normalizedUrl + "\\n" + fixedPolicyId)` as a POP-local cache identity. Signature, expiry, and user identity are excluded. Valid public page images use a one-hour shared-cache TTL and a shorter five-minute browser TTL. Errors, redirects, unknown/VVIP sources, and responses carrying `Set-Cookie` are never cached. Cloudflare Cache API storage is local to a POP/data center; a miss in one POP does not imply a global miss.

Committed configuration sets the non-secret `ENABLE_PROVIDER_IMAGE_PROXY=true` so eligible public images use Cloudflare as the primary delivery path. Configure the same private 32+ random-byte `COMIC_GATEWAY_SIGNING_SECRET` used by NEXORA only in Cloudflare; never commit it or add it as a plain-text Wrangler variable. The endpoint still fails closed when that secret is absent or invalid. For an emergency kill switch, set `ENABLE_PROVIDER_IMAGE_PROXY=false` in Cloudflare and redeploy; NEXORA V1 keeps a single same-origin Vercel fallback attempt.

## Production rollout

Merge and deploy the gateway change before evaluating savings. Confirm `/health` reports `publicImageProxyEnabled:true`; NEXORA V1 already emits Cloudflare URLs first for MangaDex, Shinigami, Voratoon, and Ainzscans. MangaDotNet stays on the Vercel legacy route until its verified Cloudflare upstream 403 is resolved. ManhwaDesu, DoujinDesu, and ManhwaLand remain excluded; the VVIP path never enters this public cache.

Do not enable `ENABLE_IMAGE_DELIVERY`: that separate R2 path remains disabled and is unrelated to provider proxy delivery. A failed Cloudflare image gets one same-origin Vercel fallback attempt, preventing reader breakage while keeping the normal path off Vercel Functions and Fast Origin Transfer.

## API surface

| Path | Behavior |
| --- | --- |
| `GET /health` | Health/config snapshot without secrets |
| `GET /fixture/image.svg` | Locally generated test SVG; no third-party requests |
| `GET /pilot/comic-page-v1.svg` | Public versioned static image fixture; Cloudflare serves assets-first |
| `GET /v1/image?key=...&exp=...&sig=...` | Returns 503 `PILOT_DISABLED` at this stage |
| `GET /v1/public-image?ticket=...&sig=...` | Primary signed public-provider proxy; requires the Cloudflare signing secret and rejects invalid/expired tickets |
| Other paths | 404 |

## Rules for future work

Only images **owned by NEXORA or expressly licensed for commercial redistribution** can enter an optional R2 bucket under `public/`. External comic providers must be assessed separately for API and distribution permissions. The Stage 3 public-provider rollout is approved and declaratively enabled. Keep the source/host allowlists narrow, retain the signed-ticket gate, and use the explicit false kill switch if provider behavior or legal review changes.

Even if licensed content is stored in R2, never mix VVIP material into this public-image gateway. An independent fail-closed membership gate and security review are required before any VVIP image delivery is migrated. Short-lived signed URLs are not a full replacement for membership checks.

If R2 licensed-public-image delivery is later approved, bind R2 as `IMAGE_BUCKET`, set a Cloudflare runtime secret `GATEWAY_HMAC_SECRET` (random 32+ chars **generated privately**), and have a trusted signer issue 5-minute `GET\n<key>\n<expiry>` HMAC-SHA256 signatures. Keep `ENABLE_IMAGE_DELIVERY=false` until all integration tests and permission checks pass. Do **not** share the secret with ChatGPT or put it in GitHub.

The next migration step is measuring CDN/origin transfer for authorized *public* content. Avoid public caching of routes whose access changes with user membership.
