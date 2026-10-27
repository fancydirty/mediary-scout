import { Suspense } from "react";
import { redirect } from "next/navigation";

/**
 * Legacy `/w/<storageId>` workspace URLs now redirect to the unified library (`/`),
 * preserving any query parameters (`?tab=library`, `?q=...`).
 */
export default function WorkspaceHomePage({
  searchParams,
}: {
  params: Promise<{ storageId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<div className="app-shell" />}>
      <RedirectToUnifiedHome searchParams={searchParams} />
    </Suspense>
  );
}

async function RedirectToUnifiedHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}): Promise<never> {
  const sp = (await searchParams) ?? {};
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") {
      qs.set(k, v);
    } else if (Array.isArray(v)) {
      for (const item of v) qs.append(k, item);
    }
  }
  const suffix = qs.toString();
  redirect(suffix ? `/?${suffix}` : "/");
}
