import { detectPlatform, orderDownloads, formatStars, postersFrom, WORKER_BASE } from "./lib.mjs";

const REPO = "fancydirty/mediary-scout";
const STARS_FALLBACK = 968;

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function fetchJson(url, ms = 4000) {
  const res = await fetch(url, { signal: timeoutSignal(ms) });
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
  // Map by platform NAME via each button's explicit data-dl-platform, not by DOM
  // order: orderDownloads reverses items for Windows visitors, and every button's
  // icon/label is platform-fixed in the HTML. Reading the platform off the element
  // keeps the href under the right icon even if buttons are reordered/added.
  const byPlatform = Object.fromEntries(items.map((it) => [it.platform, it]));

  // Hero buttons (the macOS one also shows the version).
  document.querySelectorAll("[data-dl]").forEach((a) => {
    const it = byPlatform[a.dataset.dlPlatform]; if (!it) return;
    a.href = it.url;
    const label = a.querySelector("[data-dl-label]"); if (label) label.textContent = it.label;
    const ver = a.querySelector("[data-dl-ver]"); if (ver && a.dataset.dlPlatform === "mac") ver.textContent = version;
  });

  // Final-CTA buttons (static labels).
  document.querySelectorAll("[data-dl-cta]").forEach((btn) => {
    const it = byPlatform[btn.dataset.dlPlatform];
    if (it) btn.href = it.url;
  });
}

async function wireStars() {
  let n = STARS_FALLBACK;
  try { n = (await fetchJson(`https://api.github.com/repos/${REPO}`)).stargazers_count; } catch {}
  document.querySelectorAll("[data-stars]").forEach((el) => { el.textContent = `★ ${formatStars(n)}`; });
}

async function wirePosters() {
  const wall = document.querySelector(".poster-wall");
  if (!wall) return;
  let feeds;
  try {
    feeds = await Promise.all([
      fetchJson(`${WORKER_BASE}/trending/movie/week?language=zh-CN`),
      fetchJson(`${WORKER_BASE}/trending/tv/week?language=zh-CN`),
    ]);
  } catch {
    try {
      feeds = (await fetchJson("./data/posters-fallback.json")).feeds;
    } catch {
      console.warn("poster feeds unavailable; poster wall stays empty");
      return;
    }
  }
  wall.replaceChildren(
    ...postersFrom(feeds, 18).map((p) => {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = p.url;
      img.alt = p.title ? `${p.title} 海报` : "影视海报";
      return img;
    }),
  );
}

function initFeatureReveal() {
  const items = document.querySelectorAll('.feat-item');
  if (items.length === 0) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    items.forEach((item) => item.classList.add('visible'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, idx) => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          entry.target.classList.add('visible');
        }, idx * 60);
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  items.forEach((item) => io.observe(item));
}

function initHowScrolly() {
  const wrap = document.querySelector('.how-wrap');
  if (!wrap) return;

  const lines = wrap.querySelectorAll('.how-line');
  const captions = wrap.querySelectorAll('.how-caption');
  const eps = wrap.querySelectorAll('.how-eps i[data-fill]');
  const counter = wrap.querySelector('.how-count');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentScene = 0;

  function setScene(n) {
    currentScene = n;

    lines.forEach((line) => {
      const need = +line.dataset.need;
      line.classList.remove('on', 'done');

      if (need < 3 && n >= need) {
        line.classList.add('on');
      }
      if (need === 3 && n >= 3) {
        line.classList.add('done');
      }
    });

    captions.forEach((cap) => {
      cap.classList.toggle('on', +cap.dataset.cap === n);
    });

    eps.forEach((ep) => {
      ep.classList.toggle('got', n >= 3);
    });

    if (counter) {
      counter.textContent = n >= 3 ? '12' : '8';
    }
  }

  if (reduced) {
    setScene(3);
    captions.forEach((cap) => cap.classList.add('on'));
    return;
  }

  const markers = Array.from(wrap.querySelectorAll('.how-marker'));
  const intersecting = new Map(); // Track intersection state of each marker

  const io = new IntersectionObserver((entries) => {
    // Update intersection state for each entry
    entries.forEach((entry) => {
      const scene = +entry.target.dataset.scene;
      intersecting.set(scene, entry.isIntersecting);
    });

    // Find the highest scene that's currently intersecting
    let maxScene = -1;
    for (let i = 0; i <= 3; i++) {
      if (intersecting.get(i)) {
        maxScene = i;
      }
    }

    // If no scene is intersecting, default to scene 0
    if (maxScene >= 0) {
      setScene(maxScene);
    } else {
      setScene(0);
    }
  }, {
    rootMargin: '-40% 0px -40% 0px',
    threshold: 0
  });

  markers.forEach((marker) => io.observe(marker));
  setScene(0);
}

function initFAQ() {
  const faqs = [...document.querySelectorAll("details.faq")];
  if (faqs.length === 0) return;
  // Exclusivity is native via <details name="faq"> (Chrome 120+ / FF 130+ / Safari
  // 17.2+). This toggle listener is a progressive-enhancement FALLBACK for older
  // engines without name-grouping: when one opens, close the others. It drives the
  // native [open], so a11y semantics and the CSS ::details-content animation stay
  // fully native/correct. No effect where name-grouping already handles it.
  faqs.forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open) faqs.forEach((o) => { if (o !== d) o.open = false; });
    });
  });
}

function initNavScroll() {
  const nav = document.querySelector("nav");
  if (!nav) return;

  let ticking = false;

  function checkScroll() {
    const scrolled = window.scrollY > 8;
    nav.classList.toggle("nav-scrolled", scrolled);
    ticking = false;
  }

  window.addEventListener("scroll", () => {
    if (!ticking) {
      requestAnimationFrame(checkScroll);
      ticking = true;
    }
  }, { passive: true });

  // Check initial state
  checkScroll();
}

wireDownloads();
wireStars();
wirePosters();
initHowScrolly();
initFeatureReveal();
initFAQ();
initNavScroll();
