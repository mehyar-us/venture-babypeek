/* MSRC — Mehyar Source Capture v1.0 (staged 2026-10-05)
 *
 * One shared snippet every *.mehyar.us product page loads. First-touch
 * attribution, first-party only — no third-party cookies, no fingerprinting.
 *
 * Captures on first page view of a 90-day window (does NOT overwrite an
 * existing capture — first touch wins):
 *   utm_source, utm_medium, utm_campaign, utm_term, utm_content,
 *   gclid, fbclid, msclkid, ttclid, wbraid, gbraid,
 *   referrer, landing_page (path), landing_ts
 *
 * Storage: first-party cookie `msrc` (90d, path=/, SameSite=Lax) mirrored in
 * localStorage. Use window.MSRC.get() at checkout time and forward the
 * object as `attribution` in the checkout POST body — the centralized
 * checkout threads it into billing_payments.attribution_json + Stripe
 * session metadata, and the webhook hardens it into the CRM rows.
 *
 * The pure function `parseAttribution(url, referrer)` has no DOM deps and
 * is unit-testable under node (see 99-verify.js).
 */
(function () {
  "use strict";

  var KEYS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid", "msclkid", "ttclid", "wbraid", "gbraid",
  ];

  function clean(v, max) {
    return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, max || 120);
  }

  // Pure: (urlString, referrerString) -> attribution object. No DOM.
  function parseAttribution(urlString, referrerString) {
    var out = {};
    var search = "";
    var path = "";
    try {
      var u = new URL(urlString || "");
      search = u.search || "";
      path = u.pathname || "";
    } catch (e) {
      search = "";
    }
    var i, k;
    if (search) {
      for (i = 0; i < KEYS.length; i++) {
        k = KEYS[i];
        var m = search.match(new RegExp("[?&]" + k + "=([^&#]*)"));
        if (m) {
          var v = clean(decodeURIComponent(m[1].replace(/\+/g, " ")));
          if (v) out[k] = v;
        }
      }
    }
    var ref = clean(referrerString, 300);
    if (ref) out.referrer = ref;
    if (path) out.landing_page = clean(path, 200);
    return out;
  }

  function readCookie() {
    try {
      var m = document.cookie.match(/(?:^|; )msrc=([^;]*)/);
      if (!m) return null;
      return JSON.parse(decodeURIComponent(m[1]));
    } catch (e) {
      return null;
    }
  }

  function writeCookie(obj) {
    try {
      var v = encodeURIComponent(JSON.stringify(obj));
      document.cookie =
        "msrc=" + v +
        "; path=/; max-age=7776000; SameSite=Lax" +
        (location.protocol === "https:" ? "; Secure" : "");
      try { localStorage.setItem("msrc", JSON.stringify(obj)); } catch (e) {}
    } catch (e) {}
  }

  function capture() {
    var existing = readCookie();
    if (existing && existing.landing_ts) return existing; // first touch wins
    var out = parseAttribution(String(location.href), document.referrer || "");
    out.landing_ts = new Date().toISOString();
    writeCookie(out);
    return out;
  }

  function get() {
    return readCookie() || capture();
  }

  // Auto-capture on load; guarded for non-DOM environments.
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.MSRC = { get: get, capture: capture, parse: parseAttribution };
    try {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", capture);
      } else {
        capture();
      }
    } catch (e) {}
  }

  // node export for unit tests
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseAttribution: parseAttribution };
  }
})();
