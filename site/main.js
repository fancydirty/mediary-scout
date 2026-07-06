import { detectPlatform, orderDownloads, formatStars } from "./lib.mjs";

const REPO = "fancydirty/mediary-scout";
const STARS_FALLBACK = 968;

async function fetchJson(url, ms = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function wireDownloads() {
  let release;
  try {
    release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch {
    try {
      release = await fetchJson("./data/release-fallback.json");
    } catch {
      console.warn("release info unavailable; keeping static download links");
      return; // HTML's hardcoded hrefs (releases/latest page) stay usable
    }
  }
  const { version, items } = orderDownloads(release, detectPlatform(navigator.userAgent));
  document.querySelectorAll("[data-dl]").forEach((a, i) => {
    const it = items[i]; if (!it) return;
    a.href = it.url;
    a.querySelector("[data-dl-label]").textContent = it.label;
    if (i === 0) a.querySelector("[data-dl-ver]").textContent = version;
  });
}

async function wireStars() {
  let n = STARS_FALLBACK;
  try { n = (await fetchJson(`https://api.github.com/repos/${REPO}`)).stargazers_count; } catch {}
  document.querySelectorAll("[data-stars]").forEach((el) => { el.textContent = `★ ${formatStars(n)}`; });
}

wireDownloads();
wireStars();
