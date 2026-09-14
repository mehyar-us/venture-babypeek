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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
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

async function genImage(env, prompt) {
  const out = await env.AI.run(IMAGE_MODEL, { prompt });
  return aiImageBytes(out);
}

async function runPipeline(env, id, b64a, b64b) {
  const db = env.BABYPEEK_DB;
  try {
    const features = await describeParents(env, b64a, b64b);
    const fullPrompt =
      `Adorable newborn baby portrait blending these family traits: ${features}. ` +
      `Soft studio lighting, sweet peaceful expression, photorealistic, ultra detailed skin texture, ` +
      `centered head-and-shoulders composition, plain soft background`;
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
        "UPDATE generations SET status='ready', features=?, full_key=?, teaser_key=? WHERE id=?"
      )
      .bind(features, fullKey, teaserKey, id)
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

    const id = newId();
    const now = Math.floor(Date.now() / 1000);
    const [b1, b2] = await Promise.all([
      f1.arrayBuffer().then((b) => new Uint8Array(b)),
      f2.arrayBuffer().then((b) => new Uint8Array(b)),
    ]);
    await db
      .prepare("INSERT INTO generations (id, created_at, ip, status) VALUES (?, ?, ?, 'processing')")
      .bind(id, now, ip)
      .run();
    ctx.waitUntil(runPipeline(env, id, bytesToB64(b1), bytesToB64(b2)));
    return json({ ok: true, id });
  }

  // GET /api/status/<id>
  let m = path.match(/^\/api\/status\/([0-9a-f]{32})$/);
  if (m && request.method === "GET") {
    const row = await db
      .prepare("SELECT status, error FROM generations WHERE id=?")
      .bind(m[1])
      .first();
    if (!row) return json({ ok: false, error: "unknown_id" }, 404);
    return json({ ok: true, status: row.status, error: row.error || null });
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

  // POST /api/email — capture email against a generation
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
    try {
      r = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({ product_id: PRODUCT_ID, email, params: { gid: id } }),
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
    await db.prepare("UPDATE generations SET access_token=? WHERE id=?").bind(token, id).run();
    return json({ ok: true });
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
    return env.ASSETS.fetch(request);
  },
};
