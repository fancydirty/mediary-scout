"use client";

import { useState } from "react";
import { Pan115QrConnect } from "./pan115-qr-connect";
import { QuarkQrConnect } from "./quark-qr-connect";
import { QuarkCookieConnect } from "./quark-cookie-connect";
import { GuangYaTokenConnect } from "./guangya-token-connect";

type Brand = "pan115" | "quark" | "guangya";

/** Settings "添加网盘": pick a brand, then connect it. Both brands scan a QR; 夸克
 *  keeps a collapsed cookie-paste fallback (the QR cookie-exchange is the fragile
 *  hop). Each bound drive becomes its own isolated workspace (tree model). */
export function AddDriveBrandTabs() {
  const [brand, setBrand] = useState<Brand>("pan115");

  return (
    <div>
      <div className="tab-row" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          className={brand === "pan115" ? "primary-button" : "secondary-button"}
          onClick={() => setBrand("pan115")}
          aria-pressed={brand === "pan115"}
        >
          115 网盘
        </button>
        <button
          type="button"
          className={brand === "quark" ? "primary-button" : "secondary-button"}
          onClick={() => setBrand("quark")}
          aria-pressed={brand === "quark"}
        >
          夸克网盘
        </button>
        <button
          type="button"
          className={brand === "guangya" ? "primary-button" : "secondary-button"}
          onClick={() => setBrand("guangya")}
          aria-pressed={brand === "guangya"}
        >
          光鸭云盘
        </button>
      </div>
      {brand === "pan115" ? (
        <Pan115QrConnect />
      ) : brand === "guangya" ? (
        <GuangYaTokenConnect />
      ) : (
        <div>
          <QuarkQrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 cookie
            </summary>
            <div style={{ marginTop: 10 }}>
              <QuarkCookieConnect />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
