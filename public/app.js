// BabyPeek frontend — upload → generate → teaser → $5 unlock → reveal.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const views = ["view-upload", "view-loading", "view-teaser", "view-unlocked"];
  const LS_GID = "babypeek_gid";
  const LS_EMAIL = "babypeek_email";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let photo1 = null, photo2 = null, gid = localStorage.getItem(LS_GID) || null;

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
      if (!d.ok) throw new Error(d.error || "generate_failed");
      gid = d.id;
      localStorage.setItem(LS_GID, gid);
      pollTimer = setInterval(async () => {
        try {
          const s = await (await fetch("/api/status/" + gid)).json();
          if (s.status === "ready") {
            clearInterval(pollTimer); clearInterval(msgTimer);
            $("teaser-img").src = "/api/teaser/" + gid + "?t=" + Date.now();
            const em = localStorage.getItem(LS_EMAIL);
            if (em) $("email").value = em;
            show("view-teaser");
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

  // ---- unlock: email → centralized Stripe checkout ----
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
        body: JSON.stringify({ id: gid, email }),
      });
      const d = await r.json();
      if (!d.ok || !d.checkout_url) throw new Error(d.error || "checkout_failed");
      window.location.href = d.checkout_url;
    } catch (e) {
      err("teaser-error", "Checkout hiccup — please try again in a moment.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock full portrait — $5";
    }
  });

  // ---- return from Stripe: ?token= → redeem → reveal ----
  async function redeemFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const token = q.get("token");
    if (!token) return false;
    const id = gid || localStorage.getItem(LS_GID);
    if (!id) return false;
    try {
      await fetch("/api/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, token }),
      });
      const src = "/api/full/" + id + "?token=" + encodeURIComponent(token);
      $("full-img").src = src;
      $("btn-download").href = src + "&download=1";
      show("view-unlocked");
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

  redeemFromUrl();
})();
