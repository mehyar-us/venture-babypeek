# 👶 BabyPeek — Peek at Your Future Baby

**Live:** https://baby.mehyar.us

Upload two photos (you + your partner, or any two people). AI describes both faces with a vision model, blends their traits into a newborn portrait with FLUX, and shows you a blurred sneak peek **free**. Unlock the full portrait + download for **$5** via the centralized MehyarSoft Stripe checkout.

## How it works

1. `POST /api/generate` — two photos in → generation `id` out (async; pipeline runs in `waitUntil`)
2. Vision (`@cf/meta/llama-3.2-11b-vision-instruct`) describes both parents' inheritable features
3. FLUX.1-schnell generates the full portrait **and** a genuinely-blurred teaser version (separate "heavy blur" prompt — teaser pixels contain no recoverable face)
4. `GET /api/status/:id` — poll until `ready`
5. `GET /api/teaser/:id` — free blurred teaser (watermarked in the UI)
6. Email capture → `POST /api/checkout` proxies to `https://mehyar.us/api/pay/checkout` (`product_id: baby-peek`, $5, centralized Stripe — no keys here)
7. Stripe success → `/?token={access_token}` → `POST /api/redeem` → `GET /api/full/:id?token=` serves the portrait

## Stack

- Cloudflare Worker (`src/index.js`) + Static Assets (`public/`)
- Workers AI binding (vision + FLUX), D1 (`babypeek_prod`), R2 (`babypeek-images`)
- No secrets in the repo or in `wrangler.toml` — none needed

## Deploy

**Only** via GitHub Actions (`.github/workflows/deploy.yml`) on push to `main`. Never run `wrangler pages deploy` from a repo directory — it wipes dashboard env vars on Pages projects.

## Billing

Product row `baby-peek` lives in the mehyar-web D1 (`mehyar_leads_prod.billing_products`): $5, `fulfillment='none'`, success URL `https://baby.mehyar.us/?token={access_token}`.

## Disclaimer

Just for fun — not a genetic prediction. Shown on the landing page and footer.
