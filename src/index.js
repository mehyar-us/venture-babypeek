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
    const teaserPrompt =
      `Extremely blurry out-of-focus photograph of a newborn baby with these traits: ${features}. ` +
      `Face completely unrecognizable, dreamy pastel bokeh, soft indistinct shapes only, ` +
      `no sharp details anywhere, heavy gaussian blur look`;
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

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
