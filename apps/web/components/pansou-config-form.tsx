"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { savePanSouBaseUrlAction } from "../app/actions";

const PANSOU_SELF_HOST_TUTORIAL_URL =
  "https://github.com/fancydirty/mediary-scout/blob/main/docs/pansou-self-host.md";

export function PanSouConfigForm({
  baseURL: initialBaseURL,
  isDesktop = false,
}: {
  baseURL: string;
  isDesktop?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [baseURL, setBaseURL] = useState(initialBaseURL);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const res = await savePanSouBaseUrlAction(baseURL);
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      {isDesktop ? (
        <p className="panel-note" style={{ marginBottom: 6 }}>
          桌面端<b>不含</b> PanSou 容器。未在下方配置时，默认指向作者的公共实例（资源有限、偶尔不稳）。想要更丰富的网盘源（尤其 115 分享、4K），建议自建一个配好频道的 PanSou 实例，把地址填在下方。
          {" "}
          <a href={PANSOU_SELF_HOST_TUTORIAL_URL} target="_blank" rel="noopener noreferrer">
            查看自建教程 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
          </a>
        </p>
      ) : (
        <p className="panel-note" style={{ marginBottom: 6 }}>
          PanSou 是默认的网盘资源搜索源（已内置、开箱即用）。docker compose 部署会自动指向自带的 PanSou 容器；想换成别的实例或公共域名时在此手填覆盖。留空则回退到环境变量 / 公共默认实例。
        </p>
      )}
      <p className="push-help" style={{ marginBottom: 12 }}>
        了解 PanSou{" "}
        <a href="https://github.com/fish2018/pansou" target="_blank" rel="noopener noreferrer">
          项目主页 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <div className="push-field">
        <label className="push-label">服务地址（网盘搜索源）</label>
        <div className="setting-row">
          <input
            type="text"
            className="setting-control"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="形如 http://host:port，留空用默认实例"
            aria-label="PanSou Base URL"
          />
          <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
            保存
          </button>
        </div>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
