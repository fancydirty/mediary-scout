"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * The search box. Submitting used to be a NATIVE `<form action>` GET — which is a
 * full document navigation (Next only intercepts <Link>/router.push), so the whole
 * page reloaded and the shell + header visibly flashed. Here onSubmit does a CLIENT
 * soft navigation instead: the prerendered static shell (sidebar + this header)
 * persists and only the results Suspense hole re-fetches — no full-page flash.
 *
 * `action`/hidden `tab` are kept so it still works as a plain GET if JS is off.
 */
export function SearchForm({
  basePath = "/",
  defaultQuery = "",
}: {
  basePath?: string;
  defaultQuery?: string;
}) {
  const router = useRouter();
  return (
    <form
      className="search-form"
      role="search"
      action={basePath}
      onSubmit={(event) => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get("q") ?? "");
        router.push(`${basePath}?tab=search&q=${encodeURIComponent(value)}`);
      }}
    >
      <input type="hidden" name="tab" value="search" />
      <label className="search-box search-box-large">
        <Search size={18} aria-hidden />
        <input name="q" aria-label="搜索媒体" placeholder="片名 / 剧名" defaultValue={defaultQuery} />
      </label>
      <button className="primary-button" type="submit">
        <Search size={16} aria-hidden />
        搜索
      </button>
    </form>
  );
}
