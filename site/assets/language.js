/* Keep static English/Chinese pages aligned with the visitor's preference. */
(() => {
  "use strict";
  const storageKey = "virtuoso-bridge-docs-language";
  const params = new URLSearchParams(location.search);
  const requested = params.get("lang")?.toLowerCase();
  const current = document.documentElement.lang.toLowerCase().startsWith("zh") ? "zh" : "en";
  const alternate = document.querySelector('meta[name="language-alternate"]')?.content;
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
  const browser = (navigator.languages?.[0] || navigator.language || "en").toLowerCase();
  const preferred = requested?.startsWith("zh")
    ? "zh"
    : requested?.startsWith("en")
      ? "en"
      : stored || (browser.startsWith("zh") ? "zh" : "en");

  if (requested) {
    try { localStorage.setItem(storageKey, preferred); } catch { /* Storage may be disabled. */ }
  }

  if (alternate && preferred !== current) {
    const target = new URL(alternate, location.href);
    target.search = location.search;
    target.hash = location.hash;
    location.replace(target);
    return;
  }

  const wireLanguageLinks = () => {
    document.querySelectorAll("[data-language-choice]").forEach((link) => {
      link.addEventListener("click", () => {
        try { localStorage.setItem(storageKey, link.dataset.languageChoice); } catch { /* Storage may be disabled. */ }
      });
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireLanguageLinks, { once: true });
  else wireLanguageLinks();
})();
