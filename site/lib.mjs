export function detectPlatform(ua) {
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "win";
  return "other";
}

const RELEASES_PAGE = "https://github.com/fancydirty/mediary-scout/releases/latest";

export function orderDownloads(release, platform) {
  const assets = release?.assets ?? [];
  const find = (re) => assets.find((a) => re.test(a.name))?.browser_download_url;
  const items = [
    { platform: "mac", label: "macOS", url: find(/\.dmg$/) ?? RELEASES_PAGE },
    { platform: "win", label: "Windows", url: find(/\.exe$/) ?? RELEASES_PAGE },
  ];
  if (platform === "win") items.reverse();
  return { version: release?.tag_name ?? "", items };
}

export function formatStars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function postersFrom(feeds, limit) {
  if (limit <= 0) return [];
  const out = [];
  for (const feed of feeds) {
    for (const r of feed?.results ?? []) {
      if (!r.poster_path) continue;
      out.push({ url: `https://image.tmdb.org/t/p/w342${r.poster_path}`, title: r.title ?? r.name ?? "" });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
