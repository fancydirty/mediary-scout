"use client";

import { useState } from "react";
import { Pan115QrConnect } from "./pan115-qr-connect";
import { QuarkQrConnect } from "./quark-qr-connect";
import { QuarkCookieConnect } from "./quark-cookie-connect";
import { GuangYaTokenConnect } from "./guangya-token-connect";
import { TianyiQrConnect } from "./tianyi-qr-connect";
import { TianyiSsonConnect } from "./tianyi-sson-connect";

type Brand = "pan115" | "quark" | "guangya" | "tianyi";

/** Settings "添加网盘": pick a brand, then connect it. 115/夸克/天翼 scan a QR
 *  (夸克折叠 cookie 粘贴回退、天翼折叠 SSON 粘贴回退——QR 的凭证兑换是易碎跳),光鸭粘
 *  token。Each bound drive becomes its own isolated workspace (tree model). */
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
        <button
          type="button"
          className={brand === "tianyi" ? "primary-button" : "secondary-button"}
          onClick={() => setBrand("tianyi")}
          aria-pressed={brand === "tianyi"}
        >
          天翼云盘
        </button>
      </div>
      {brand === "pan115" ? (
        <Pan115QrConnect />
      ) : brand === "guangya" ? (
        <GuangYaTokenConnect />
      ) : brand === "tianyi" ? (
        <div>
          <TianyiQrConnect />
          <details style={{ marginTop: 12 }}>
            <summary className="panel-note" style={{ cursor: "pointer" }}>
              扫码不行？手动粘 SSON cookie
            </summary>
            <div style={{ marginTop: 10 }}>
              <TianyiSsonConnect />
            </div>
          </details>
        </div>
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
