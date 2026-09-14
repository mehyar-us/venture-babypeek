# BabyPeek 👶🔮

**See your future baby.** Upload two parent photos → AI generates a
photorealistic newborn portrait blending both parents' traits.

Live: **https://baby.mehyar.us** · $5 unlock via centralized Stripe checkout.

## How it works

1. **Upload** two parent photos (browser resizes to 1024px JPEG).
2. **Vision** — Llama 3.2 11B Vision describes each parent's inheritable
   traits. **One image per call**: the model 3030-errors whenever a single
   call carries two `image_url` entries, so two parallel single-image calls
   are fanned out and combined.
3. **Generate** — FLUX-1-schnell renders two images in parallel:
   - the **full portrait** (sharp newborn photo),
   - the **teaser**: an extreme close-up of the baby's tiny hand — no face
     in the pixels at all, so nothing can leak or be de-blurred. (FLUX
     actively sharpens faces no matter how hard a prompt begs for blur, so
     a "blurred face" teaser was abandoned after live testing.)
4. **Email capture** before the paywall (stored on the generation row).
5. **$5 checkout** through the centralized mehyar-web Stripe endpoint
   (`POST mehyar.us/api/pay/checkout`, product `baby-peek`). Price comes
   from the DB; `params.gid` is stored in `billing_payments.metadata_json`.
6. **Redeem** — `POST /api/redeem` verifies the token **server-to-server**
   against the central billing D1 (`BILLING_DB` binding → `mehyar_leads_prod`):
   token must belong to a `paid` `baby-peek` payment whose metadata `gid`
   matches the generation. Unpaid tokens → 402; cross-generation reuse → 403.
7. **Unlock** — `GET /api/full/:id?token=` serves the portrait
   (`?download=1` forces download).

Entertainment only — the site carries a lighthearted "not a prediction"
disclaimer. Parent uploads are processed in memory and never persisted;
only the generated images live in R2 (`babypeek-images`).

## Stack

- Cloudflare Worker `babypeek` (repo: `mehyar-us/venture-babypeek`)
- D1 `babypeek_prod` (generations), R2 `babypeek-images`
- Workers AI: `@cf/meta/llama-3.2-11b-vision-instruct`,
  `@cf/black-forest-labs/flux-1-schnell`
- Billing: centralized Stripe on mehyar-web (`billing_products` /
  `billing_payments`), product id `baby-peek`, $5.00 USD
- Deploy: GitHub Actions → `baby.mehyar.us` (never `wrangler pages deploy`
  from a repo with `[vars]`)

## Verified end-to-end (2026-09-14)

Upload → ready → teaser → email → `cs_test_` checkout → paid redeem →
full portrait; unpaid/wrong-generation tokens correctly rejected (402/403).
