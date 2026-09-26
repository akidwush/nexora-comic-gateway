# NEXORA Comic Gateway — Cloudflare Stage 1

This repository is the **standalone Cloudflare Worker pilot** for NEXORA V1. It was copied from the tested, isolated stage-one branch of `akidwush/all-tools-nexora`. There are no build scripts or deploy hooks for the NEXORA V1 Vercel production project.

**Scope today:** our own tiny SVG fixture, health endpoint, and a **disabled-by-default** licensed-public-image R2 streaming handler. There is NO MangaDex or other third-party provider proxy, no VVIP membership implementation, no VVIP image caching, no arbitrary URL proxy, no uploader, and no R2 bucket binding at this stage.

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

## API surface

| Path | Behavior |
| --- | --- |
| `GET /health` | Health/config snapshot without secrets |
| `GET /fixture/image.svg` | Locally generated test SVG; no third-party requests |
| `GET /v1/image?key=...&exp=...&sig=...` | Returns 503 `PILOT_DISABLED` at this stage |
| Other paths | 404 |

## Rules for future work

Only images **owned by NEXORA or expressly licensed for commercial redistribution** can enter an optional R2 bucket under `public/`. External comic providers must be assessed separately for API and distribution permissions. Do not enable MangaDex or other provider fetches without verifying their terms and necessary permissions.

Even if licensed content is stored in R2, never mix VVIP material into this public-image gateway. An independent fail-closed membership gate and security review are required before any VVIP image delivery is migrated. Short-lived signed URLs are not a full replacement for membership checks.

If R2 licensed-public-image delivery is later approved, bind R2 as `IMAGE_BUCKET`, set a Cloudflare runtime secret `GATEWAY_HMAC_SECRET` (random 32+ chars **generated privately**), and have a trusted signer issue 5-minute `GET\n<key>\n<expiry>` HMAC-SHA256 signatures. Keep `ENABLE_IMAGE_DELIVERY=false` until all integration tests and permission checks pass. Do **not** share the secret with ChatGPT or put it in GitHub.

The next migration step is measuring CDN/origin transfer for authorized *public* content. Avoid public caching of routes whose access changes with user membership.
