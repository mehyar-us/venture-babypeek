// BabyPeek worker — AI future-baby portrait generator.
// API routes live under /api/*; the marketing/app frontend is served from
// [assets] (./public). AI via the Workers AI binding, state in D1, images in R2.
// Payments go through the centralized mehyar-web checkout (this worker only
// proxies the request server-side, so no CORS issues and no Stripe keys here).

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const CHECKOUT_URL = "https://mehyar.us/api/pay/checkout";
const PRODUCT_ID = "baby-peek";
// mehyar.us edge bot-blocking (CF 1010) rejects non-browser UAs — always spoof.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const RATE_LIMIT_PER_HOUR = 8;

// ── Free-first-render ladder (2026-10-06, E18) ─────────────────────────
// FREE_FIRST=true: a visitor's first render per IP per day is FREE (one AI
// baby portrait, no payment, no account). The $17 unlock becomes the Deluxe
// Pack: 2 bonus variations + age progression (5 & 15) + full-res HD download.
// Set FREE_FIRST=false and redeploy to revert to the $17-before-taste funnel.
const FREE_FIRST = true;
const FREE_PER_IP_PER_24H = 1;
const FREE_ALARM_PER_DAY = 200; // soft alarm threshold (see recordFreeMetrics)

// Inference cost model (published Cloudflare rates, 2026-10-06 — logged as
// estimates, not metered usage):
//   flux-1-schnell: 4.80 neurons per 512x512 tile + 9.60 neurons per step
//     (default 4 steps). Output ≈1024x1024 (4 tiles) → 57.6 neurons/image.
//   neuron price: $0.011 / 1,000 neurons.
//   llama-3.2-11b-vision-instruct: $0.049 / 1M input tokens, $0.676 / 1M out;
//     ~2.5k in-tokens + ~60 out-tokens per photo call → ≈$0.00016/call.
const FLUX_NEURONS_PER_IMAGE = 57.6;
const NEURON_USD = 0.011 / 1000;
const VISION_CALL_USD = 0.00016;
const fluxImageCostUsd = () => FLUX_NEURONS_PER_IMAGE * NEURON_USD;

async function sha256Hex(s) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return [...new Uint8Array(d)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// Abuse guard: 1 free render per IP per 24h. KV is primary (auto-expiring
// keys, no buyer data — keys are SHA-256 hashes of the IP, values are the
// generation id). D1 is the fallback if the KV binding is missing.
// On grant, the KV key is marked immediately; runFreePipeline releases it
// again if the pipeline ERRORS, so a failed render doesn't burn the grant.
async function freeGrantCheck(env, db, ip) {
  const day = new Date().toISOString().slice(0, 10); // UTC day
  if (env.FREE_KV) {
    try {
      const key = "free:" + day + ":" + (await sha256Hex(ip));
      if (await env.FREE_KV.get(key))
        return { ok: false, reason: "free_limit" };
      return { ok: true, key };
    } catch {
      /* fall through to D1 */
    }
  }
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const cnt = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM generations WHERE ip=? AND created_at>? AND tier='free'"
    )
    .bind(ip, dayAgo)
    .first();
  if (cnt && cnt.n >= FREE_PER_IP_PER_24H)
    return { ok: false, reason: "free_limit" };
  return { ok: true, key: null };
}

async function freeGrantMark(env, key, id) {
  if (env.FREE_KV && key) {
    try {
      await env.FREE_KV.put(key, id, { expirationTtl: 172800 });
    } catch {
      /* D1 fallback already guards */
    }
  }
}

async function freeGrantRelease(env, key) {
  if (env.FREE_KV && key) {
    try {
      await env.FREE_KV.delete(key);
    } catch {
      /* best effort */
    }
  }
}

// Soft alarm: counts free renders/day in D1 and flags the viral-day case.
// No external calls (no email sends allowed) — the morning review reads the
// free_metrics table. console.error keeps it visible in worker logs too.
async function recordFreeMetrics(db, costUsd) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await db
      .prepare(
        "INSERT INTO free_metrics (day, renders, est_cost_usd, alerted) VALUES (?, 1, ?, 0) " +
          "ON CONFLICT(day) DO UPDATE SET renders=renders+1, est_cost_usd=est_cost_usd+excluded.est_cost_usd"
      )
      .bind(day, costUsd)
      .run();
    const row = await db
      .prepare("SELECT renders, alerted FROM free_metrics WHERE day=?")
      .bind(day)
      .first();
    if (row && row.renders > FREE_ALARM_PER_DAY && !row.alerted) {
      await db
        .prepare("UPDATE free_metrics SET alerted=1 WHERE day=?")
        .bind(day)
        .run();
      console.error(
        `FREE ALARM: baby.mehyar.us free renders ${row.renders} > ${FREE_ALARM_PER_DAY} on ${day}`
      );
    }
  } catch (e) {
    console.error("free_metrics note: " + String((e && e.message) || e).slice(0, 200));
  }
}

// Cost-only variant: adds inference spend WITHOUT incrementing the render
// count. Used for the Deluxe-extras pre-generation overhead (E18 close fix)
// so free_metrics.renders keeps counting renders 1:1 for the 10/8 verdict.
async function recordFreeCost(db, costUsd) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await db
      .prepare(
        "INSERT INTO free_metrics (day, renders, est_cost_usd, alerted) VALUES (?, 0, ?, 0) " +
          "ON CONFLICT(day) DO UPDATE SET est_cost_usd=est_cost_usd+excluded.est_cost_usd"
      )
      .bind(day, costUsd)
      .run();
  } catch (e) {
    console.error("free_cost note: " + String((e && e.message) || e).slice(0, 200));
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ── Funnel ladder columns (2026-10-06: $17 reprice + $9 bump + $27 upsell) ─
// bump_paid: buyer added the $9 Couple Pack at checkout (v3/v4 unlocked).
// agepack_*: the $27 Age Progression Pack upsell (ages 1/3/10/20).
// Defensive: the ALTERs also run here so a missed migration can't 500 the
// funnel; the canonical schema lives in schema.sql.
async function ensureFunnelColumns(db) {
  try {
    const info = await db.prepare("PRAGMA table_info(generations)").all();
    const cols = new Set((info.results || []).map((r) => r.name));
    if (!cols.has("bump_paid"))
      await db.prepare("ALTER TABLE generations ADD COLUMN bump_paid INTEGER NOT NULL DEFAULT 0").run();
    if (!cols.has("agepack_token"))
      await db.prepare("ALTER TABLE generations ADD COLUMN agepack_token TEXT").run();
    if (!cols.has("agepack_status"))
      await db.prepare("ALTER TABLE generations ADD COLUMN agepack_status TEXT NOT NULL DEFAULT 'none'").run();
    if (!cols.has("agepack_json"))
      await db.prepare("ALTER TABLE generations ADD COLUMN agepack_json TEXT").run();
  } catch (e) {
    console.error("ensureFunnelColumns note: " + String((e && e.message) || e).slice(0, 120));
  }
}

function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Workers AI binding returns different shapes per model/call path —
// normalize them all to raw image bytes.
async function aiImageBytes(out) {
  if (!out) throw new Error("empty AI image response");
  if (out instanceof ReadableStream)
    return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (ArrayBuffer.isView(out))
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  if (typeof out === "string") return b64ToBytes(out);
  if (typeof out === "object") {
    if (typeof out.image === "string") return b64ToBytes(out.image);
    if (out.result && typeof out.result.image === "string")
      return b64ToBytes(out.result.image);
  }
  throw new Error("unexpected AI image response shape");
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

// ── Central contact store (shared with mehyar.jobs) ──────────────────
// Every email signup (teaser capture, checkout) is mirrored into the
// email_contact table of the shared contacts D1 (brand = 'babypeek'),
// so all signups across every product are queryable in one place.
// Best-effort: sync failures are logged, never break the signup flow.

function providerOf(email) {
  const dom = String(email || "").split("@")[1] || "";
  if (dom === "gmail.com" || dom === "googlemail.com") return "gmail";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(dom))
    return "outlook";
  if (dom === "yahoo.com" || dom === "ymail.com" || dom.endsWith(".yahoo.com"))
    return "yahoo";
  if (["icloud.com", "me.com", "mac.com"].includes(dom)) return "apple";
  return "other";
}

async function syncCentralContact(env, email, source) {
  try {
    const db = env.CONTACTS_DB;
    if (!db) return;
    const em = String(email || "").toLowerCase().trim();
    if (!EMAIL_RE.test(em)) return;
    const now = new Date().toISOString();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS email_contact (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          brand TEXT NOT NULL DEFAULT 'babypeek',
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'babypeek',
          first_name TEXT, last_name TEXT, city TEXT, state TEXT, role_title TEXT,
          provider TEXT NOT NULL DEFAULT 'other',
          user_id INTEGER,
          consent_log_json TEXT NOT NULL DEFAULT '[]',
          sent_count INTEGER NOT NULL DEFAULT 0,
          last_sent_at TEXT,
          week_sent_count INTEGER NOT NULL DEFAULT 0,
          week_start TEXT,
          imported_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(email, brand)
        )`
      )
      .run();
    const consent = JSON.stringify([
      { ts: now, source, action: "opt_in", via: "babypeek-web" },
    ]);
    const ins = await db
      .prepare(
        `INSERT INTO email_contact (email, brand, status, source, provider, consent_log_json, imported_at)
         VALUES (?, 'babypeek', 'pending', ?, ?, ?, ?)
         ON CONFLICT(email, brand) DO NOTHING`
      )
      .bind(em, source, providerOf(em), consent, now)
      .run();
    if (!Number(ins && ins.meta && ins.meta.changes)) {
      // Existing row: never resurrect an opted-out contact; otherwise
      // refresh the source and append a consent record.
      const row = await db
        .prepare(
          "SELECT id, status, consent_log_json FROM email_contact WHERE email=? AND brand='babypeek'"
        )
        .bind(em)
        .first();
      if (row && row.status !== "opted_out") {
        let log = [];
        try {
          log = JSON.parse(row.consent_log_json || "[]");
        } catch {
          /* keep empty */
        }
        log.push({ ts: now, source, action: "opt_in", via: "babypeek-web" });
        await db
          .prepare(
            "UPDATE email_contact SET source=?, consent_log_json=?, imported_at=? WHERE id=?"
          )
          .bind(source, JSON.stringify(log).slice(0, 4000), now, row.id)
          .run();
      }
    }
  } catch (e) {
    console.error("central contact sync failed:", e && e.message);
  }
}

// ── Unsubscribe tokens ───────────────────────────────────────────────
// HMAC-signed one-click tokens (same shape as the mehyar.jobs system:
// b64url(payload).hexsig over "unsub:<payload>"). BabyPeek mints its own
// with UNSUBSCRIBE_SECRET. Every marketing email we send must include:
//   https://baby.mehyar.us/api/unsubscribe?token=<token>
// plus the sender's physical mailing address (CAN-SPAM).

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(msg)
  );
  return [...new Uint8Array(sig)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function signUnsubscribe(email, env) {
  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ em: String(email).toLowerCase().trim(), br: "babypeek" })
    )
  );
  const sig = await hmacHex(env.UNSUBSCRIBE_SECRET, "unsub:" + payload);
  return payload + "." + sig;
}

async function verifyUnsubscribe(token, env) {
  try {
    const secret = env.UNSUBSCRIBE_SECRET;
    if (!secret || !token) return null;
    const parts = String(token).split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expect = await hmacHex(secret, "unsub:" + parts[0]);
    if (parts[1].length !== expect.length) return null;
    let diff = 0;
    for (let i = 0; i < parts[1].length; i++)
      diff |= parts[1].charCodeAt(i) ^ expect.charCodeAt(i);
    if (diff) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const em = String((data && data.em) || "").toLowerCase().trim();
    if (!EMAIL_RE.test(em)) return null;
    return { email: em, brand: String((data && data.br) || "babypeek") };
  } catch {
    return null;
  }
}

// Helper for future mailers (BabyPeek sends no marketing email today).
// Kept next to the verifier so the footer snippet can't drift out of sync.
async function unsubscribeUrlFor(email, env, origin) {
  const t = await signUnsubscribe(email, env);
  return origin + "/api/unsubscribe?token=" + t;
}

// NOTE (2026-09-14): llama-3.2-11b-vision-instruct 3030s ("Internal Server
// Error") whenever a single call carries TWO image_url entries — even tiny
// ones. One image per call works fine. So: two parallel single-image calls.
async function describeOneParent(env, b64, label) {
  const out = await env.AI.run(VISION_MODEL, {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Describe this person's most distinctive inheritable facial features in one short phrase: " +
              "skin tone, hair color and texture, eye color and shape, face shape. " +
              "Reply with only the phrase, nothing else.",
          },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
        ],
      },
    ],
    max_tokens: 120,
  });
  const text = (out && (out.response || (out.result && out.result.response))) || "";
  const clean = String(text).replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean) throw new Error("vision model returned no description for " + label);
  return `${label}: ${clean}`;
}

async function describeParents(env, b64a, b64b) {
  const [a, b] = await Promise.all([
    describeOneParent(env, b64a, "Parent 1"),
    describeOneParent(env, b64b, "Parent 2"),
  ]);
  return `${a} | ${b}`;
}

function fullPortraitPrompt(features) {
  return (
    `Adorable newborn baby portrait blending these family traits: ${features}. ` +
    `Soft studio lighting, sweet peaceful expression, photorealistic, ultra detailed skin texture, ` +
    `centered head-and-shoulders composition, plain soft background`
  );
}

async function genImage(env, prompt) {
  // NOTE (2026-10-06): Workers AI flux-1-schnell rejects a `seed` param
  // ("Additional or unevaluated properties '/seed' not allowed") — the
  // E18 commit's seed plumbing broke every deluxe-extras generation until
  // this fix. Prompts already differ per job; FLUX is non-deterministic
  // without a seed. Do NOT re-add seed without verifying the schema.
  const out = await env.AI.run(IMAGE_MODEL, { prompt });
  return aiImageBytes(out);
}

// Free-first pipeline: ONE full portrait (no teaser — the portrait itself is
// the free render). Logs estimated inference cost per render.
async function runFreePipeline(env, id, b64a, b64b, grantKey) {
  const db = env.BABYPEEK_DB;
  try {
    const features = await describeParents(env, b64a, b64b);
    const fullBytes = await genImage(env, fullPortraitPrompt(features));
    const fullKey = `g/${id}/full.jpg`;
    await env.BABYPEEK_R2.put(fullKey, fullBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const cost = 2 * VISION_CALL_USD + fluxImageCostUsd();
    await db
      .prepare(
        "UPDATE generations SET status='ready', features=?, full_key=?, teaser_key=NULL, tier='free', est_cost_usd=? WHERE id=?"
      )
      .bind(features, fullKey, cost, id)
      .run();
    await recordFreeMetrics(db, cost);
    // E18 close fix (2026-10-06): pre-generate the Deluxe extras for free
    // renders so the free-result page can show blurred age-progression
    // teasers (the close mechanic). Atomic claim so a concurrent redeem
    // can't double-run; redeem skips regeneration when extras_status is
    // not 'none'/'error', so a buyer gets a near-instant unlock.
    try {
      const claim = await db
        .prepare(
          "UPDATE generations SET extras_status='processing' WHERE id=? AND extras_status='none'"
        )
        .bind(id)
        .run();
      if (claim && claim.meta && claim.meta.changes === 1) {
        const extraCost = await runExtras(env, id);
        // Cost-only: do NOT increment the render count (the E18 clock reads
        // free_metrics.renders — one render = one count, extras are overhead).
        if (extraCost > 0) await recordFreeCost(db, extraCost);
      }
    } catch (e2) {
      console.error(
        "free extras pre-gen note: " +
          String((e2 && e2.message) || e2).slice(0, 200)
      );
    }
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await db
      .prepare("UPDATE generations SET status='error', error=? WHERE id=?")
      .bind(msg, id)
      .run();
    // Failed render must not burn the user's free grant.
    await freeGrantRelease(env, grantKey);
  }
}

// Deluxe-pack pipeline (post-$17 unlock): 2 bonus variations + age progression
// at 5 and 15. Runs async after /api/redeem verifies payment.
async function runExtras(env, id) {
  const db = env.BABYPEEK_DB;
  try {
    const row = await db
      .prepare("SELECT features FROM generations WHERE id=?")
      .bind(id)
      .first();
    const features =
      (row && row.features) || "a cute newborn baby's features";
    const jobs = [
      [
        "v1",
        `Adorable newborn baby portrait blending these family traits: ${features}. ` +
          `Playful different pose, soft window light, photorealistic, ultra detailed skin, ` +
          `centered head-and-shoulders, plain soft background`,
      ],
      [
        "v2",
        `Sweet sleeping newborn baby portrait with these family traits: ${features}. ` +
          `Cozy knitted blanket, gentle morning light, photorealistic close portrait`,
      ],
      [
        "age5",
        `Cheerful 5-year-old child portrait — the same child grown up, family traits: ${features}. ` +
          `Bright natural light, photorealistic, head-and-shoulders`,
      ],
      [
        "age15",
        `Happy 15-year-old teenager portrait — the same child as a teenager, family traits: ${features}. ` +
          `Natural outdoor light, photorealistic, head-and-shoulders`,
      ],
      // Couple Pack bump ($9 at checkout): 2 bonus variations, delivered
      // only when the generation's bump_paid flag is set (gated in
      // /api/extras). Pre-generated with the rest so the unlock is instant.
      [
        "v3",
        `Adorable newborn baby portrait blending these family traits: ${features}. ` +
          `Dreamy close-up, tiny knit hat, soft pastel backdrop, photorealistic, ultra detailed skin`,
      ],
      [
        "v4",
        `Joyful newborn baby portrait with these family traits: ${features}. ` +
          `Gentle smile, cozy white wrap, bright airy studio light, photorealistic, head-and-shoulders`,
      ],
    ];
    const out = [];
    for (const [kind, prompt] of jobs) {
      const bytes = await genImage(env, prompt);
      const key = `g/${id}/${kind}.jpg`;
      await env.BABYPEEK_R2.put(key, bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      out.push({ kind, key });
    }
    const cost = jobs.length * fluxImageCostUsd();
    await db
      .prepare(
        "UPDATE generations SET extras_status='ready', extras_json=?, est_cost_usd=COALESCE(est_cost_usd,0)+? WHERE id=?"
      )
      .bind(JSON.stringify(out), cost, id)
      .run();
    return cost;
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await db
      .prepare(
        "UPDATE generations SET extras_status='error', extras_json=? WHERE id=?"
      )
      .bind(JSON.stringify({ error: msg }), id)
      .run();
    return 0;
  }
}

// Age Progression Pack upsell ($27, post-purchase): the rest of the
// timeline — the same child at ages 1, 3, 10 and 20. Triggered only by a
// verified upsell purchase (/api/upsell or /api/agepack-fulfill), never
// pre-generated: this is paid-only content. Atomic claim by the caller;
// this function just runs and records.
async function runAgepack(env, id) {
  const db = env.BABYPEEK_DB;
  try {
    const row = await db
      .prepare("SELECT features FROM generations WHERE id=?")
      .bind(id)
      .first();
    const features =
      (row && row.features) || "a cute newborn baby's features";
    const ages = [
      ["a1", "1-year-old toddler"],
      ["a3", "3-year-old child"],
      ["a10", "10-year-old child"],
      ["a20", "20-year-old young adult"],
    ];
    const out = [];
    for (const [kind, label] of ages) {
      const bytes = await genImage(
        env,
        `${label} portrait — the same child grown up, family traits: ${features}. ` +
          `Natural light, warm genuine expression, photorealistic, head-and-shoulders`
      );
      const key = `g/${id}/${kind}.jpg`;
      await env.BABYPEEK_R2.put(key, bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      out.push({ kind, key });
    }
    const cost = ages.length * fluxImageCostUsd();
    await db
      .prepare(
        "UPDATE generations SET agepack_status='ready', agepack_json=?, est_cost_usd=COALESCE(est_cost_usd,0)+? WHERE id=?"
      )
      .bind(JSON.stringify(out), cost, id)
      .run();
    return cost;
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await db
      .prepare(
        "UPDATE generations SET agepack_status='error', agepack_json=? WHERE id=?"
      )
      .bind(JSON.stringify({ error: msg }), id)
      .run();
    return 0;
  }
}

// Atomically claim the agepack generation slot (none/error -> processing).
// Returns true when THIS caller won the claim.
async function claimAgepack(db, id) {
  const claim = await db
    .prepare(
      "UPDATE generations SET agepack_status='processing' WHERE id=? AND agepack_status IN ('none','error')"
    )
    .bind(id)
    .run();
  return !!(claim && claim.meta && claim.meta.changes === 1);
}

async function runPipeline(env, id, b64a, b64b) {
  const db = env.BABYPEEK_DB;
  try {
    const features = await describeParents(env, b64a, b64b);
    const fullPrompt = fullPortraitPrompt(features);
    // Teaser strategy (2026-09-14): FLUX actively sharpens faces no matter how
    // hard the prompt begs for blur — a "blurred face" teaser always leaked
    // the face. So the teaser never contains a face at all: an extreme
    // close-up of the newborn's tiny hand. Tender, intriguing, and there is
    // literally no face in the pixels to recover.
    const teaserPrompt =
      `Extreme close-up macro photograph of a newborn baby's tiny hand gently wrapped around a parent's finger, ` +
      `soft newborn skin with fine detail, shallow depth of field, warm soft studio lighting, dreamy and tender. ` +
      `Baby's family traits: ${features}. ` +
      `IMPORTANT: only the tiny hand and the finger are visible, absolutely no face, no eyes, no head in the frame.`;
    const [fullBytes, teaserBytes] = await Promise.all([
      genImage(env, fullPrompt),
      genImage(env, teaserPrompt),
    ]);
    const fullKey = `g/${id}/full.jpg`;
    const teaserKey = `g/${id}/teaser.jpg`;
    await env.BABYPEEK_R2.put(fullKey, fullBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    await env.BABYPEEK_R2.put(teaserKey, teaserBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    await db
      .prepare(
        "UPDATE generations SET status='ready', features=?, full_key=?, teaser_key=?, est_cost_usd=? WHERE id=?"
      )
      .bind(features, fullKey, teaserKey, 2 * VISION_CALL_USD + 2 * fluxImageCostUsd(), id)
      .run();
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await db
      .prepare("UPDATE generations SET status='error', error=? WHERE id=?")
      .bind(msg, id)
      .run();
  }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.BABYPEEK_DB;

  // POST /api/generate — two photos in, generation id out (async via waitUntil)
  if (path === "/api/generate" && request.method === "POST") {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: "bad_upload" }, 400);
    }
    const f1 = form.get("photo1");
    const f2 = form.get("photo2");
    for (const [f, name] of [
      [f1, "photo1"],
      [f2, "photo2"],
    ]) {
      if (!f || typeof f.arrayBuffer !== "function")
        return json({ ok: false, error: "missing_" + name }, 400);
      if (!String(f.type || "").startsWith("image/"))
        return json({ ok: false, error: "not_image_" + name }, 400);
      if (f.size === 0 || f.size > MAX_PHOTO_BYTES)
        return json({ ok: false, error: "bad_size_" + name }, 400);
    }
    const ip = clientIp(request);
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const cnt = await db
      .prepare("SELECT COUNT(*) AS n FROM generations WHERE ip=? AND created_at>?")
      .bind(ip, hourAgo)
      .first();
    if (cnt && cnt.n >= RATE_LIMIT_PER_HOUR)
      return json({ ok: false, error: "rate_limited" }, 429);

    // Free-first ladder: 1 free render per IP per 24h (abuse guard).
    let grant = { ok: true, key: null };
    if (FREE_FIRST) {
      grant = await freeGrantCheck(env, db, ip);
      if (!grant.ok)
        return json(
          {
            ok: false,
            error: "free_limit",
            message:
              "That's your free portrait for today — come back tomorrow, or unlock the Deluxe Pack below.",
          },
          429
        );
    }

    const id = newId();
    const now = Math.floor(Date.now() / 1000);
    // Render-source attribution (E18 measurement): first-touch utm/src threaded
    // from the page at upload time. Sanitized, non-identifying, nullable.
    let src = null;
    try {
      const raw = String(form.get("src") || "");
      const clean = raw.replace(/[^a-zA-Z0-9_.\-]/g, "").slice(0, 64);
      if (clean) src = clean;
    } catch (e) { /* ignore — src is best-effort */ }
    const [b1, b2] = await Promise.all([
      f1.arrayBuffer().then((b) => new Uint8Array(b)),
      f2.arrayBuffer().then((b) => new Uint8Array(b)),
    ]);
    await db
      .prepare(
        "INSERT INTO generations (id, created_at, ip, status, tier, src) VALUES (?, ?, ?, 'processing', ?, ?)"
      )
      .bind(id, now, ip, FREE_FIRST ? "free" : "paid", src)
      .run();
    if (grant.key) await freeGrantMark(env, grant.key, id);
    if (FREE_FIRST) ctx.waitUntil(runFreePipeline(env, id, bytesToB64(b1), bytesToB64(b2), grant.key));
    else ctx.waitUntil(runPipeline(env, id, bytesToB64(b1), bytesToB64(b2)));
    return json({ ok: true, id, free: FREE_FIRST });
  }

  // GET /api/free/<id> — the free first render (full portrait, no token).
  // The id is a 32-hex secret — unguessable, same posture as /api/teaser.
  // Only serves tier='free' generations; paid portraits stay token-gated.
  let m = path.match(/^\/api\/free\/([0-9a-f]{32})$/);
  if (m && request.method === "GET") {
    const row = await db
      .prepare("SELECT full_key, status, tier FROM generations WHERE id=?")
      .bind(m[1])
      .first();
    if (!row || row.status !== "ready" || row.tier !== "free" || !row.full_key)
      return json({ ok: false, error: "not_ready" }, 404);
    const obj = await env.BABYPEEK_R2.get(row.full_key);
    if (!obj) return json({ ok: false, error: "missing" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  // GET /api/status/<id>
  m = path.match(/^\/api\/status\/([0-9a-f]{32})$/);
  if (m && request.method === "GET") {
    const row = await db
      .prepare("SELECT status, error, extras_status, created_at FROM generations WHERE id=?")
      .bind(m[1])
      .first();
    if (!row) return json({ ok: false, error: "unknown_id" }, 404);
    let extrasStatus = row.extras_status || "none";
    // Stale-claim self-heal (2026-10-07): runExtras has no retries/timeouts,
    // so a hung flux call leaves extras_status='processing' forever and the
    // free-result page's teaser poll spins indefinitely on the close mechanic.
    // The read path heals it: after 15 min (6 sequential images finish well
    // under this), 'processing' is reaped to 'error' — the page hides the
    // teaser gracefully (already-designed state) and the redeem claim's
    // IN('none','error') takes over, regenerating on purchase. Idempotent.
    if (extrasStatus === "processing" && row.created_at) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - Number(row.created_at) > 900) {
        await db
          .prepare("UPDATE generations SET extras_status='error' WHERE id=? AND extras_status='processing'")
          .bind(m[1])
          .run();
        extrasStatus = "error";
      }
    }
    return json({
      ok: true,
      status: row.status,
      error: row.error || null,
      extras_status: extrasStatus,
    });
  }

  // GET /api/teaser/<id> — public blurred teaser
  m = path.match(/^\/api\/teaser\/([0-9a-f]{32})$/);
  if (m && request.method === "GET") {
    const row = await db
      .prepare("SELECT teaser_key, status FROM generations WHERE id=?")
      .bind(m[1])
      .first();
    if (!row || row.status !== "ready" || !row.teaser_key)
      return json({ ok: false, error: "not_ready" }, 404);
    const obj = await env.BABYPEEK_R2.get(row.teaser_key);
    if (!obj) return json({ ok: false, error: "missing" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  // GET /api/teaser-img/<id>/<kind> — blurred age-progression previews for
  // the free-result page's Deluxe teaser (E18 close fix, 2026-10-06).
  // No token: same exposure level as /api/free/<id> (unguessable 32-hex id).
  // The page applies a CSS blur + lock overlay; these are the buyer's own
  // pre-generated Deluxe images, revealed in full after the $17 unlock.
  m = path.match(/^\/api\/teaser-img\/([0-9a-f]{32})\/(age5|age15)$/);
  if (m && request.method === "GET") {
    const row = await db
      .prepare("SELECT extras_status FROM generations WHERE id=?")
      .bind(m[1])
      .first();
    if (!row || row.extras_status !== "ready")
      return json({ ok: false, error: "not_ready" }, 404);
    const obj = await env.BABYPEEK_R2.get(`g/${m[1]}/${m[2]}.jpg`);
    if (!obj) return json({ ok: false, error: "missing" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  // POST /api/email — capture email against a generation
  // POST /api/intent — unlock-intent beacon (E18 10/8 verdict instrumentation).
  // Fire-and-forget click telemetry for the free-result close rung:
  // kind 'teaser' = the blurred-teaser CTA was clicked (scrolled to unlock card);
  // kind 'unlock' = a valid-email $17 unlock attempt reached the checkout call.
  // No PII: gid is the opaque render id; email is deliberately NOT stored here.
  // Table is created lazily (same additive pattern as email_contact).
  if (path === "/api/intent" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const kind = String(body.kind || "");
    if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, error: "bad_id" }, 400);
    if (kind !== "teaser" && kind !== "unlock") return json({ ok: false, error: "bad_kind" }, 400);
    try {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS unlock_intents (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           gid TEXT NOT NULL,
           kind TEXT NOT NULL,
           src TEXT,
           created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`).run();
      const row = await db.prepare("SELECT src FROM generations WHERE id=?").bind(id).first();
      await db.prepare("INSERT INTO unlock_intents (gid, kind, src) VALUES (?,?,?)")
        .bind(id, kind, row ? row.src : null).run();
    } catch (e) {
      console.error("intent note: " + String((e && e.message) || e).slice(0, 200));
    }
    return json({ ok: true });
  }

  if (path === "/api/email" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const email = String(body.email || "").toLowerCase().trim();
    if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, error: "bad_id" }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    await db.prepare("UPDATE generations SET email=? WHERE id=?").bind(email, id).run();
    // Mirror into the shared central contact store (best-effort).
    ctx.waitUntil(syncCentralContact(env, email, "babypeek-teaser"));
    return json({ ok: true });
  }

  // POST /api/subscribe — standalone homepage email capture (pre-purchase list).
  // No generation id needed; mirrors into the shared central contact store
  // with brand='babypeek' so the per-brand CRM list (babypeek_subscribers)
  // can be backfilled from it. Suppression-safe: syncCentralContact never
  // re-activates an unsubscribed row.
  if (path === "/api/subscribe" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").toLowerCase().trim();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    ctx.waitUntil(syncCentralContact(env, email, "babypeek-homepage"));
    return json({ ok: true });
  }

  // POST /api/checkout — proxy to the centralized mehyar-web Stripe checkout
  if (path === "/api/checkout" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const email = String(body.email || "").toLowerCase().trim();
    if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, error: "bad_id" }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    const row = await db.prepare("SELECT id FROM generations WHERE id=?").bind(id).first();
    if (!row) return json({ ok: false, error: "unknown_id" }, 404);
    await db.prepare("UPDATE generations SET email=? WHERE id=?").bind(email, id).run();
    // Mirror into the shared central contact store (best-effort).
    ctx.waitUntil(syncCentralContact(env, email, "babypeek-checkout"));
    let r;
    // Funnel ladder (2026-10-06): save_card keeps the card on file for the
    // one-tap $27 Age Progression Pack upsell; bump forwards the buyer's
    // opt-in to the $9 Couple Pack order bump (the checkbox on the page
    // starts UNCHECKED — no pre-checked add-ons, compliance item 9).
    // Both are set server-side here; the browser cannot set params directly.
    const payload = {
      product_id: PRODUCT_ID,
      email,
      params: { gid: id, save_card: true },
    };
    if (body.bump === true) payload.params.bump = true;
    if (body.attribution && typeof body.attribution === "object") {
      payload.params.attribution = body.attribution; // <=512B enforced server-side
    }
    if (body.test === true) payload.test = true; // QA only; live UI never sends this
    try {
      r = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      return json({ ok: false, error: "checkout_unreachable" }, 502);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.checkout_url)
      return json({ ok: false, error: "checkout_failed" }, 502);
    return json({ ok: true, checkout_url: data.checkout_url });
  }

  // POST /api/agepack-redeem — browser return from the fallback hosted
  // checkout (?agepack_token=). Looks the generation up by the agepack
  // token, verifies it against the central ledger, and kicks generation
  // (idempotent claim). Returns the gid so the client can show progress.
  if (path === "/api/agepack-redeem" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const token = String(body.agepack_token || "").slice(0, 128);
    if (!/^[0-9a-f]{64}$/.test(token))
      return json({ ok: false, error: "bad_request" }, 400);
    await ensureFunnelColumns(db);
    let pay = null;
    try {
      pay = await env.BILLING_DB.prepare(
        "SELECT product_id, status, metadata_json FROM billing_payments WHERE access_token=?"
      )
        .bind(token)
        .first();
    } catch {
      return json({ ok: false, error: "verify_unavailable" }, 502);
    }
    let gid = "";
    try {
      gid = (JSON.parse((pay && pay.metadata_json) || "{}") || {}).gid || "";
    } catch {
      /* ignore malformed metadata */
    }
    if (!pay || pay.product_id !== "baby-peek-agepack" || pay.status !== "paid" || !/^[0-9a-f]{32}$/.test(gid))
      return json({ ok: false, error: "not_paid" }, 402);
    await db
      .prepare("UPDATE generations SET agepack_token=? WHERE id=? AND (agepack_token IS NULL OR agepack_token != ?)")
      .bind(token, gid, token)
      .run();
    if (await claimAgepack(db, gid)) {
      ctx.waitUntil(runAgepack(env, gid));
    }
    const st = await db
      .prepare("SELECT agepack_status FROM generations WHERE id=?")
      .bind(gid)
      .first();
    return json({ ok: true, gid, agepack_status: (st && st.agepack_status) || "none" });
  }

  // POST /api/redeem — link the Stripe success token to a generation.
  // The token is verified SERVER-TO-SERVER against the central billing
  // ledger (BILLING_DB = mehyar_leads_prod.billing_payments): it must belong
  // to a PAID baby-peek payment whose metadata names THIS generation.
  // A token from an unpaid/abandoned checkout, or from another generation,
  // can never unlock anything.
  if (path === "/api/redeem" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const token = String(body.token || "").slice(0, 128);
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(token))
      return json({ ok: false, error: "bad_request" }, 400);
    let pay = null;
    try {
      pay = await env.BILLING_DB.prepare(
        "SELECT product_id, status, metadata_json FROM billing_payments WHERE access_token=?"
      )
        .bind(token)
        .first();
    } catch {
      return json({ ok: false, error: "verify_unavailable" }, 502);
    }
    if (!pay || pay.product_id !== PRODUCT_ID || pay.status !== "paid")
      return json({ ok: false, error: "not_paid" }, 402);
    let gid = "";
    try {
      gid = (JSON.parse(pay.metadata_json || "{}") || {}).gid || "";
    } catch {
      /* ignore malformed metadata */
    }
    if (gid !== id) return json({ ok: false, error: "token_mismatch" }, 403);
    await ensureFunnelColumns(db);
    // Couple Pack bump: the payment's metadata records the opt-in (set
    // server-side in /api/checkout from the buyer's unchecked-by-default
    // checkbox). Flip the flag on — never off.
    let bumpPaid = false;
    try {
      bumpPaid = (JSON.parse(pay.metadata_json || "{}") || {}).bump === true;
    } catch {
      /* ignore malformed metadata */
    }
    await db
      .prepare(
        "UPDATE generations SET access_token=?, bump_paid=CASE WHEN ?=1 THEN 1 ELSE bump_paid END WHERE id=?"
      )
      .bind(token, bumpPaid ? 1 : 0, id)
      .run();
    // Paid unlock = Deluxe Pack: auto-generate 2 bonus variations + age
    // progression (5 & 15) so the buyer gets what the pitch promised.
    // Atomic claim (fixes the old read-then-write race): regenerates when
    // the free pipeline's pre-gen errored, skips when it's already
    // processing/ready (E18 close fix pre-generates extras at free-render
    // time, so most buyers unlock instantly).
    const claim = await db
      .prepare(
        "UPDATE generations SET extras_status='processing' WHERE id=? AND extras_status IN ('none','error')"
      )
      .bind(id)
      .run();
    if (claim && claim.meta && claim.meta.changes === 1) {
      ctx.waitUntil(runExtras(env, id));
    }
    return json({ ok: true });
  }

  // POST /api/upsell — one-click Age Progression Pack upsell ($27).
  // Body: { id, token } where token is the DELUXE access token. The worker
  // verifies the base purchase server-to-server in the central ledger, then
  // calls the central one-click charge endpoint (mehyar.us/api/pay/upsell-
  // charge), which charges the card saved at checkout — no card re-entry.
  // On success the agepack token is stored and generation is claimed
  // atomically (double-clicks and the webhook-fulfillment race are safe).
  // When the card needs the buyer present (SCA) the endpoint returns
  // requires_action + a hosted checkout_url fallback instead.
  if (path === "/api/upsell" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const token = String(body.token || "").slice(0, 128);
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(token))
      return json({ ok: false, error: "bad_request" }, 400);
    await ensureFunnelColumns(db);
    let base = null;
    try {
      base = await env.BILLING_DB.prepare(
        "SELECT product_id, status, metadata_json, email, stripe_session_id FROM billing_payments WHERE access_token=?"
      )
        .bind(token)
        .first();
    } catch {
      return json({ ok: false, error: "verify_unavailable" }, 502);
    }
    let gid = "";
    try {
      gid = (JSON.parse((base && base.metadata_json) || "{}") || {}).gid || "";
    } catch {
      /* ignore malformed metadata */
    }
    if (!base || base.product_id !== PRODUCT_ID || base.status !== "paid" || gid !== id)
      return json({ ok: false, error: "not_paid" }, 402);
    // Already bought? Hand back the token, charge nothing.
    const have = await db
      .prepare("SELECT agepack_token, agepack_status FROM generations WHERE id=?")
      .bind(id)
      .first();
    if (have && have.agepack_token && have.agepack_status !== "none") {
      return json({ ok: true, already: true, agepack_token: have.agepack_token });
    }
    const testMode = String(base.stripe_session_id || "").startsWith("cs_test_");
    let r;
    try {
      r = await fetch("https://mehyar.us/api/pay/upsell-charge", {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({ base_token: token, product_id: "baby-peek-agepack", test: testMode }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      return json({ ok: false, error: "upsell_unreachable" }, 502);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const err = String((data && data.error) || "upsell_failed");
      // SCA / no saved card: fall back to a regular hosted checkout
      // session for the upsell SKU so the buyer can still complete it.
      if (err === "requires_action" || err === "no_saved_card") {
        return json({ ok: false, error: err, fallback: true });
      }
      return json({ ok: false, error: err }, 502);
    }
    const agepackToken = String(data.agepack_token || data.token || "");
    if (!/^[0-9a-f]{64}$/.test(agepackToken))
      return json({ ok: false, error: "upsell_failed" }, 502);
    await db
      .prepare("UPDATE generations SET agepack_token=? WHERE id=?")
      .bind(agepackToken, id)
      .run();
    if (await claimAgepack(db, id)) {
      ctx.waitUntil(runAgepack(env, id));
    }
    return json({ ok: true, already: !!data.already, agepack_token: agepackToken });
  }

  // POST /api/agepack-fulfill — server-to-server trigger from the central
  // billing worker after a baby-peek-agepack payment is marked paid
  // (webhook fallback session path; the one-click path triggers via
  // /api/upsell). Verifies the token against the central ledger, then
  // atomically claims generation. Idempotent: replays are no-ops.
  if (path === "/api/agepack-fulfill" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const gid = String(body.gid || "");
    const token = String(body.token || "").slice(0, 128);
    if (!/^[0-9a-f]{32}$/.test(gid) || !/^[0-9a-f]{64}$/.test(token))
      return json({ ok: false, error: "bad_request" }, 400);
    await ensureFunnelColumns(db);
    let pay = null;
    try {
      pay = await env.BILLING_DB.prepare(
        "SELECT product_id, status, metadata_json FROM billing_payments WHERE access_token=?"
      )
        .bind(token)
        .first();
    } catch {
      return json({ ok: false, error: "verify_unavailable" }, 502);
    }
    let pgid = "";
    try {
      pgid = (JSON.parse((pay && pay.metadata_json) || "{}") || {}).gid || "";
    } catch {
      /* ignore malformed metadata */
    }
    if (!pay || pay.product_id !== "baby-peek-agepack" || pay.status !== "paid" || pgid !== gid)
      return json({ ok: false, error: "not_paid" }, 402);
    await db
      .prepare("UPDATE generations SET agepack_token=? WHERE id=? AND (agepack_token IS NULL OR agepack_token != ?)")
      .bind(token, gid, token)
      .run();
    if (await claimAgepack(db, gid)) {
      ctx.waitUntil(runAgepack(env, gid));
    }
    return json({ ok: true });
  }

  // POST /api/checkout-agepack — hosted-checkout fallback for the upsell
  // (used when the one-click charge can't run: SCA cards, no saved card).
  // Same trust posture as /api/checkout: price from billing_products.
  if (path === "/api/checkout-agepack" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    const email = String(body.email || "").toLowerCase().trim();
    if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, error: "bad_id" }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    const row = await db.prepare("SELECT id FROM generations WHERE id=?").bind(id).first();
    if (!row) return json({ ok: false, error: "unknown_id" }, 404);
    const payload = { product_id: "baby-peek-agepack", email, params: { gid: id } };
    if (body.test === true) payload.test = true; // QA only; live UI never sends this
    let r;
    try {
      r = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      return json({ ok: false, error: "checkout_unreachable" }, 502);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.checkout_url)
      return json({ ok: false, error: "checkout_failed" }, 502);
    return json({ ok: true, checkout_url: data.checkout_url });
  }

  // GET /api/extras/<id>?token= — Deluxe Pack status + image URLs (token-gated)
  // Token may be the Deluxe access_token OR the Age Progression Pack
  // agepack_token — both belong to the same buyer. v3/v4 (Couple Pack bump)
  // are included only when bump_paid=1; agepack items only when the upsell
  // was purchased (agepack_token set).
  m = path.match(/^\/api\/extras\/([0-9a-f]{32})$/);
  if (m && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    await ensureFunnelColumns(db);
    const row = await db
      .prepare(
        "SELECT access_token, agepack_token, extras_status, extras_json, " +
          "agepack_status, agepack_json, bump_paid FROM generations WHERE id=?"
      )
      .bind(m[1])
      .first();
    const tokenOk =
      row &&
      ((row.access_token && row.access_token === token) ||
        (row.agepack_token && row.agepack_token === token));
    if (!tokenOk) return json({ ok: false, error: "locked" }, 403);
    let items = [];
    try {
      items = JSON.parse(row.extras_json || "[]");
    } catch {
      /* keep empty */
    }
    const bumpPaid = Number(row.bump_paid) === 1;
    const agepackBought = !!(row.agepack_token || (row.agepack_status && row.agepack_status !== "none"));
    let agepackItems = [];
    try {
      agepackItems = JSON.parse(row.agepack_json || "[]");
    } catch {
      /* keep empty */
    }
    const labelFor = (kind) =>
      kind === "v1" ? "Variation 1"
      : kind === "v2" ? "Variation 2"
      : kind === "v3" ? "Couple Pack — Variation 3"
      : kind === "v4" ? "Couple Pack — Variation 4"
      : kind === "age5" ? "Your baby at 5"
      : kind === "age15" ? "Your baby at 15"
      : kind === "a1" ? "Your baby at 1"
      : kind === "a3" ? "Your baby at 3"
      : kind === "a10" ? "Your baby at 10"
      : kind === "a20" ? "Your baby at 20"
      : kind;
    const toItem = (it) => ({
      kind: it.kind,
      label: labelFor(it.kind),
      url: `/api/extras-img/${m[1]}/${it.kind}?token=${encodeURIComponent(token)}`,
    });
    const out = (Array.isArray(items) ? items : [])
      .filter((it) => it.kind === "v1" || it.kind === "v2" || it.kind === "age5" || it.kind === "age15" || ((it.kind === "v3" || it.kind === "v4") && bumpPaid))
      .map(toItem);
    if (agepackBought && row.agepack_status === "ready") {
      for (const it of (Array.isArray(agepackItems) ? agepackItems : [])) {
        if (it && typeof it.kind === "string") out.push(toItem(it));
      }
    }
    return json({
      ok: true,
      status: row.extras_status || "none",
      agepack: row.agepack_status || "none",
      bump: bumpPaid,
      items: out,
    });
  }

  // GET /api/extras-img/<id>/<kind>?token= — one Deluxe/Couple/AgePack image
  // (token-gated: Deluxe token or AgePack token). v3/v4 additionally require
  // the bump purchase; a1/a3/a10/a20 require the upsell purchase.
  m = path.match(/^\/api\/extras-img\/([0-9a-f]{32})\/(v1|v2|v3|v4|age5|age15|a1|a3|a10|a20)$/);
  if (m && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    await ensureFunnelColumns(db);
    const row = await db
      .prepare(
        "SELECT access_token, agepack_token, bump_paid, agepack_status FROM generations WHERE id=?"
      )
      .bind(m[1])
      .first();
    const tokenOk =
      row &&
      ((row.access_token && row.access_token === token) ||
        (row.agepack_token && row.agepack_token === token));
    if (!tokenOk) return json({ ok: false, error: "locked" }, 403);
    const kind = m[2];
    if ((kind === "v3" || kind === "v4") && Number(row.bump_paid) !== 1)
      return json({ ok: false, error: "missing" }, 404);
    if (kind[0] === "a" && kind !== "age5" && kind !== "age15" && !row.agepack_token)
      return json({ ok: false, error: "missing" }, 404);
    const obj = await env.BABYPEEK_R2.get(`g/${m[1]}/${kind}.jpg`);
    if (!obj) return json({ ok: false, error: "missing" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  }

  // GET /api/full/<id>?token= — the paid portrait, token-gated
  m = path.match(/^\/api\/full\/([0-9a-f]{32})$/);
  if (m && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    const row = await db
      .prepare("SELECT full_key, access_token, status FROM generations WHERE id=?")
      .bind(m[1])
      .first();
    if (!row || row.status !== "ready" || !row.access_token || row.access_token !== token)
      return json({ ok: false, error: "locked" }, 403);
    const obj = await env.BABYPEEK_R2.get(row.full_key);
    if (!obj) return json({ ok: false, error: "missing" }, 404);
    const headers = {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
    };
    if (url.searchParams.get("download") === "1")
      headers["content-disposition"] = 'attachment; filename="babypeek-baby.jpg"';
    return new Response(obj.body, { headers });
  }

  // GET /api/unsubscribe?token=… — one-click unsubscribe confirm page.
  // The token is HMAC-signed, so no login is required.
  if (path === "/api/unsubscribe" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    const v = await verifyUnsubscribe(token, env);
    if (!v)
      return new Response("Invalid or expired unsubscribe link.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    const safeEmail = v.email
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const safeToken = token.replace(/"/g, "&quot;");
    return new Response(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Unsubscribe — BabyPeek</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"></head><body><main><section class="section legal" style="text-align:center"><div class="pill">👋 Sorry to see you go</div><h1>Unsubscribe?</h1><p class="lede">Stop BabyPeek emails to<br><b>${safeEmail}</b></p><form method="POST" action="/api/unsubscribe"><input type="hidden" name="token" value="${safeToken}"><button class="cta" type="submit">Yes, unsubscribe me</button></form><p class="tiny">One click, effective immediately. No login needed.</p></section></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  // POST /api/unsubscribe — perform the opt-out (form or JSON).
  if (path === "/api/unsubscribe" && request.method === "POST") {
    let token = "";
    const ct = request.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        token = (await request.json().catch(() => ({}))).token || "";
      } else {
        const form = await request.formData().catch(() => null);
        token = (form && String(form.get("token") || "")) || "";
      }
    } catch {
      /* fall through to invalid_token */
    }
    const v = await verifyUnsubscribe(String(token || ""), env);
    if (!v) return json({ ok: false, error: "invalid_token" }, 400);
    let changed = false;
    try {
      if (env.CONTACTS_DB) {
        const r = await env.CONTACTS_DB.prepare(
          "UPDATE email_contact SET status='opted_out' WHERE email=? AND brand='babypeek' AND status != 'opted_out'"
        )
          .bind(v.email)
          .run();
        changed = Number(r && r.meta && r.meta.changes) > 0;
      }
    } catch (e) {
      console.error("unsubscribe update failed:", e && e.message);
    }
    const isForm = !ct.includes("application/json");
    if (isForm) {
      const safeEmail = v.email
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return new Response(
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Unsubscribed — BabyPeek</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/styles.css"></head><body><main><section class="section legal" style="text-align:center"><div class="pill">✅ Done</div><h1>You're unsubscribed</h1><p class="lede"><b>${safeEmail}</b> won't get BabyPeek emails anymore.</p><a class="cta" href="/">Back to BabyPeek</a></section></main></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return json({ ok: true, unsubscribed: changed });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      // 2026-10-06: ASSETS.fetch throws (Cloudflare 1101) on any missing asset
      // path instead of returning 404. Fail closed with a clean 404 so
      // mistyped URLs, crawlers, and ad display paths never 500.
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};
