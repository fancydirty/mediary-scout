"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * Returns to where the user actually came from. history.back() preserves
 * the previous list state (e.g. the search query); the fallback href covers
 * direct navigation with no history.
 */
export function BackLink({
  label = "返回",
  fallbackHref = "/",
}: {
  label?: string;
  fallbackHref?: string;
}) {
  const router = useRouter();
  return (
    <button
      className="back-link"
      type="button"
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
    >
      <ArrowLeft size={16} aria-hidden />
      {label}
    </button>
  );
}
