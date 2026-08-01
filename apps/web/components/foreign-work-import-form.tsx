"use client";

import { useState, useTransition } from "react";
import { Film } from "lucide-react";
import { importForeignWorkAction, type ForeignWorkImportActionResult } from "../app/actions";
import { runAction } from "../lib/run-action";

export function ForeignWorkImportForm({
  providerFileIds,
  suggestedTitle,
}: {
  providerFileIds: string[];
  suggestedTitle?: string;
}) {
  const [movieTitle, setMovieTitle] = useState(suggestedTitle ?? "");
  const [year, setYear] = useState("");
  const [result, setResult] = useState<ForeignWorkImportActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (result?.status === "imported") {
    return <p className="import-result success">{result.message}</p>;
  }

  return (
    <form
      className="foreign-import-form"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const r = await runAction(
            () => importForeignWorkAction({
              providerFileIds,
              movieTitle,
              year: Number(year),
            }),
            (msg) => setResult({ status: "failed", message: msg }),
          );
          if (!r.ok) return;
          setResult(r.value);
        });
      }}
    >
      <input
        aria-label="电影名称"
        placeholder="电影名称"
        required
        value={movieTitle}
        onChange={(event) => setMovieTitle(event.target.value)}
      />
      <input
        aria-label="年份"
        placeholder="年份"
        required
        inputMode="numeric"
        pattern="\d{4}"
        value={year}
        onChange={(event) => setYear(event.target.value)}
        style={{ width: 90 }}
      />
      <button className="primary-button" type="submit" disabled={pending}>
        <Film size={15} aria-hidden />
        {pending ? "入库中…" : "作为电影入库"}
      </button>
      {result?.status === "failed" ? <p className="import-result failed">{result.message}</p> : null}
    </form>
  );
}
