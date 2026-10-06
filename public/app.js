// BabyPeek frontend — upload → FREE portrait → deluxe pitch → $5 unlock → deluxe pack.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const views = ["view-upload", "view-loading", "view-free", "view-unlocked"];
  const LS_GID = "babypeek_gid";
  const LS_EMAIL = "babypeek_email";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let photo1 = null, photo2 = null, gid = localStorage.getItem(LS_GID) || null;

  // Meta Purchase events — fired once per paid unlock (dedupe per generation id).
  const purchaseFired = new Set();

  // ---- share-visit tracking: closes the share-loop measurement gap.
  //    A share recipient lands on ?utm_source=babypeek_share&utm_medium=webshare —
  //    this fires once per load so the viral leg is visible in Events Manager
  //    (share k-factor = ShareVisit events / BabyPeekShare events). No PII.
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("utm_source") === "babypeek_share") {
      window.fbq && fbq("trackCustom", "BabyPeekShareVisit", { medium: qs.get("utm_medium") || "webshare" });
    }
  } catch {}

  function show(name) {
    views.forEach((v) => $(v).classList.toggle("active", v === name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function err(id, msg) {
    const el = $(id);
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  // ---- photo pickers: preview + downscale to max 1024px (saves AI tokens) ----
  function bindPicker(inputId, prevId, upId, set) {
    const input = $(inputId);
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) return;
      if (!f.type.startsWith("image/")) { err("upload-error", "Please pick an image file."); return; }
      const img = new Image();
      const objUrl = URL.createObjectURL(f);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        const MAX = 1024;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((blob) => {
          if (!blob) { err("upload-error", "Could not read that photo — try another."); return; }
          set(blob);
          const prev = $(prevId);
          prev.src = URL.createObjectURL(blob);
          prev.hidden = false;
          $(upId).classList.add("filled");
          $(upId).querySelector(".uplus").style.display = "none";
          $(upId).querySelector(".ulabel").style.display = "none";
          err("upload-error", "");
          $("btn-generate").disabled = !(photo1 && photo2);
        }, "image/jpeg", 0.9);
      };
      img.onerror = () => err("upload-error", "Could not read that photo — try another.");
      img.src = objUrl;
    });
  }
  bindPicker("photo1", "prev1", "up1", (b) => (photo1 = b));
  bindPicker("photo2", "prev2", "up2", (b) => (photo2 = b));

  // ---- generate ----
  let pollTimer = null;
  $("btn-generate").addEventListener("click", async () => {
    if (!photo1 || !photo2) return;
    err("upload-error", "");
    show("view-loading");
    const msgs = [
      "Reading tiny faces, mixing smiles — about 30 seconds.",
      "Blending Parent 1's eyes with Parent 2's smile…",
      "Adding a dash of mischief…",
      "Warming up the studio lights…",
    ];
    let mi = 0;
    const msgTimer = setInterval(() => {
      $("loading-sub").textContent = msgs[++mi % msgs.length];
    }, 8000);
    try {
      const fd = new FormData();
      fd.append("photo1", photo1, "parent1.jpg");
      fd.append("photo2", photo2, "parent2.jpg");
      const r = await fetch("/api/generate", { method: "POST", body: fd });
      const d = await r.json();
      if (!d.ok) {
        if (d.error === "free_limit") {
          clearInterval(msgTimer);
          show("view-upload");
          err("upload-error", "That's your free portrait for today 👶 — come back tomorrow, or unlock the Deluxe Pack below.");
          return;
        }
        throw new Error(d.error || "generate_failed");
      }
      gid = d.id;
      localStorage.setItem(LS_GID, gid);
      pollTimer = setInterval(async () => {
        try {
          const s = await (await fetch("/api/status/" + gid)).json();
          if (s.status === "ready") {
            clearInterval(pollTimer); clearInterval(msgTimer);
            // Free-first: the full portrait IS the render. Preload before
            // swapping views; a 404 means a legacy teaser-funnel row.
            const probe = new Image();
            probe.onload = () => {
              $("free-img").src = "/api/free/" + gid + "?t=" + Date.now();
              const em = localStorage.getItem(LS_EMAIL);
              if (em) $("email").value = em;
              show("view-free");
            };
            probe.onerror = () => {
              show("view-upload");
              err("upload-error", "That preview expired — please generate again.");
            };
            probe.src = "/api/free/" + gid + "?t=" + Date.now();
          } else if (s.status === "error") {
            clearInterval(pollTimer); clearInterval(msgTimer);
            show("view-upload");
            err("upload-error", "Hmm, the AI stumbled (" + (s.error || "unknown") + "). Please try again.");
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) {
      clearInterval(msgTimer);
      show("view-upload");
      err("upload-error", "Could not start generation — check your connection and try again.");
    }
  });

  // ---- unlock: email → centralized Stripe checkout ($5 Deluxe Pack) ----
  $("btn-unlock").addEventListener("click", async () => {
    const email = $("email").value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { err("teaser-error", "Please enter a valid email address."); return; }
    if (!gid) { err("teaser-error", "Something went wrong — please regenerate."); return; }
    err("teaser-error", "");
    const btn = $("btn-unlock");
    btn.disabled = true;
    btn.textContent = "Opening secure checkout…";
    try {
      localStorage.setItem(LS_EMAIL, email);
      await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: gid, email }),
      });
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: gid,
          email,
          attribution: window.MSRC ? window.MSRC.get() : undefined,
        }),
      });
      const d = await r.json();
      if (!d.ok || !d.checkout_url) throw new Error(d.error || "checkout_failed");
      try { window.fbq && fbq("track", "InitiateCheckout", { value: 5.0, currency: "USD" }); } catch (e2) {}
      window.location.href = d.checkout_url;
    } catch (e) {
      err("teaser-error", "Checkout hiccup — please try again in a moment.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock deluxe — $5";
    }
  });

  // ---- return from Stripe: ?token= → redeem → deluxe pack ----
  let extrasTimer = null;
  function renderExtras(items) {
    const grid = $("extras-grid");
    grid.innerHTML = "";
    items.forEach((it) => {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = it.url;
      img.alt = it.label;
      img.loading = "lazy";
      const cap = document.createElement("figcaption");
      cap.textContent = it.label;
      fig.appendChild(img); fig.appendChild(cap);
      grid.appendChild(fig);
    });
  }
  function pollExtras(id, token) {
    const statusEl = $("extras-status");
    const tick = async () => {
      try {
        const s = await (await fetch("/api/extras/" + id + "?token=" + encodeURIComponent(token))).json();
        if (s.ok && s.status === "ready" && s.items && s.items.length) {
          clearInterval(extrasTimer); extrasTimer = null;
          statusEl.textContent = "Your bonus portraits are here ✨";
          renderExtras(s.items);
        } else if (s.ok && s.status === "error") {
          clearInterval(extrasTimer); extrasTimer = null;
          statusEl.textContent = "The bonus portraits stumbled — your portrait + HD download above are yours. Try the deluxe pack again in a bit.";
        }
      } catch { /* keep polling */ }
    };
    tick();
    extrasTimer = setInterval(tick, 5000);
  }
  async function redeemFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const token = q.get("token");
    if (!token) return false;
    const id = gid || localStorage.getItem(LS_GID);
    if (!id) return false;
    try {
      const rr = await fetch("/api/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, token }),
      });
      const rd = await rr.json().catch(() => ({}));
      if (!rd.ok) return false;
      const src = "/api/full/" + id + "?token=" + encodeURIComponent(token);
      $("full-img").src = src;
      $("btn-download").href = src + "&download=1";
      show("view-unlocked");
      pollExtras(id, token);
      // Purchase attribution for the Meta test (E16): redeem success = paid.
      // Pixel-side signal closes the D1-only attribution gap for the 10/7 kill clock.
      if (!purchaseFired.has(id)) {
        purchaseFired.add(id);
        try { window.fbq && fbq("track", "Purchase", { value: 5.0, currency: "USD" }); } catch {}
      }
      // clean the URL (keep the token out of shared links)
      history.replaceState(null, "", window.location.pathname);
      return true;
    } catch {
      return false;
    }
  }

  $("btn-again").addEventListener("click", () => {
    localStorage.removeItem(LS_GID);
    gid = null; photo1 = photo2 = null;
    window.location.href = "/";
  });

  // ---- share row (free + deluxe views): every baby photo is the ad.
  //    Shares ONLY the clean homepage funnel URL (never the tokenized /api/full
  //    image — recipient replays the free flow themselves). Native sheet on
  //    mobile (→ family group chat), clipboard fallback on desktop.
  function wireShare(btnId, firedFlag) {
    const shareBtn = $(btnId);
    if (!shareBtn) return;
    shareBtn.addEventListener("click", async () => {
      const shareUrl = "https://baby.mehyar.us/?utm_source=babypeek_share&utm_medium=webshare";
      const shareText = "I just tried BabyPeek — my baby's first AI portrait was FREE 👶";
      let method = "none";
      try {
        if (navigator.share) {
          await navigator.share({ title: "BabyPeek 👶", text: shareText, url: shareUrl });
          method = "native";
        } else {
          await navigator.clipboard.writeText(shareText + " " + shareUrl);
          method = "clipboard";
        }
      } catch (e) {
        // Dismissed sheet (AbortError) or clipboard denied — one quiet retry path.
        if (e && e.name !== "AbortError") {
          try { await navigator.clipboard.writeText(shareText + " " + shareUrl); method = "clipboard"; } catch {}
        } else return;
      }
      if (!firedFlag.done && method !== "none") {
        firedFlag.done = true;
        try { window.fbq && fbq("trackCustom", "BabyPeekShare", { method }); } catch {}
      }
      const prev = shareBtn.textContent;
      shareBtn.textContent = "💬 Link ready — send it! ✅";
      shareBtn.disabled = true;
      setTimeout(() => { shareBtn.textContent = prev; shareBtn.disabled = false; }, 4000);
    });
  }
  wireShare("btn-share", { done: false });
  wireShare("btn-share-free", { done: false });

  // ---- standalone homepage capture → POST /api/subscribe ----
  const notifyBtn = $("btn-notify");
  if (notifyBtn) {
    notifyBtn.addEventListener("click", async () => {
      const input = $("notify-email");
      const msg = $("notify-msg");
      const email = (input.value || "").trim().toLowerCase();
      msg.hidden = true;
      if (!EMAIL_RE.test(email)) {
        msg.textContent = "Please enter a valid email address.";
        msg.hidden = false;
        input.focus();
        return;
      }
      notifyBtn.disabled = true;
      notifyBtn.textContent = "Saving…";
      try {
        const r = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || "subscribe_failed");
        msg.textContent = "💛 You're on the list — talk soon!";
        msg.hidden = false;
        input.value = "";
        input.disabled = true;
        notifyBtn.textContent = "You're in ✓";
      } catch {
        msg.textContent = "Hmm, that didn't go through — please try again.";
        msg.hidden = false;
        notifyBtn.disabled = false;
        notifyBtn.textContent = "Remind me 💛";
      }
    });
  }

  redeemFromUrl();
})();
