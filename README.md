# NEXORA Comic Gateway — Cloudflare Stage 2

This repository is the **standalone Cloudflare Worker pilot** for NEXORA V1. It was copied from the tested, isolated stage-one branch of `akidwush/all-tools-nexora`. There are no build scripts or deploy hooks for the NEXORA V1 Vercel production project.

**Scope today:** the original Worker-created SVG fixture, health endpoint, **Cloudflare Static Assets for a new repository-owned comic-style test image**, and a **disabled-by-default** licensed-public-image R2 streaming handler. There is NO MangaDex or other third-party provider proxy, no VVIP membership implementation, no VVIP image caching, no arbitrary URL proxy, no uploader, and no R2 bucket binding at this stage.

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

Once deployed, check `https://<YOUR-SUBDOMAIN>.workers.dev/health` (expect `ok:true`, `stage:1`, `imageDeliveryEnabled:false`, `vvip:false`) and `https://<YOUR-SUBDOMAIN>.workers.dev/fixture/image.svg`. Send only the public Worker URL back to the assistant. Never share Cloudflare account credentials, tokens, cookies, or secrets.

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

## API surface

| Path | Behavior |
| --- | --- |
| `GET /health` | Health/config snapshot without secrets |
| `GET /fixture/image.svg` | Locally generated test SVG; no third-party requests |
| `GET /pilot/comic-page-v1.svg` | Public versioned static image fixture; Cloudflare serves assets-first |
| `GET /v1/image?key=...&exp=...&sig=...` | Returns 503 `PILOT_DISABLED` at this stage |
| Other paths | 404 |

## Rules for future work

Only images **owned by NEXORA or expressly licensed for commercial redistribution** can enter an optional R2 bucket under `public/`. External comic providers must be assessed separately for API and distribution permissions. Do not enable MangaDex or other provider fetches without verifying their terms and necessary permissions.

Even if licensed content is stored in R2, never mix VVIP material into this public-image gateway. An independent fail-closed membership gate and security review are required before any VVIP image delivery is migrated. Short-lived signed URLs are not a full replacement for membership checks.

If R2 licensed-public-image delivery is later approved, bind R2 as `IMAGE_BUCKET`, set a Cloudflare runtime secret `GATEWAY_HMAC_SECRET` (random 32+ chars **generated privately**), and have a trusted signer issue 5-minute `GET\n<key>\n<expiry>` HMAC-SHA256 signatures. Keep `ENABLE_IMAGE_DELIVERY=false` until all integration tests and permission checks pass. Do **not** share the secret with ChatGPT or put it in GitHub.

The next migration step is measuring CDN/origin transfer for authorized *public* content. Avoid public caching of routes whose access changes with user membership.
