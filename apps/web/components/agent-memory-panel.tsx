"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { deleteAgentMemoryAction, saveAgentMemoryAction, setAgentMemoryEnabledAction } from "../app/actions";
import { runAction } from "../lib/run-action";

type Kind = "search" | "resource" | "drive" | "pitfall" | "other";

export interface AgentMemoryItem {
  name: string;
  description: string;
  kind: Kind;
  body: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

type Address = { scope: "global" } | { scope: "title"; mediaType: "movie" | "tv"; tmdbId: number };

const KIND_LABEL: Record<Kind, string> = {
  search: "搜索",
  resource: "资源",
  drive: "网盘",
  pitfall: "坑",
  other: "其它",
};

const EMPTY_DRAFT = { name: "", description: "", kind: "search" as Kind, body: "" };

/**
 * The agent's notes for one work (detail page) or the shared global notes (Settings →
 * AI 模型). The agent writes them after each run; here the user can read, edit, add
 * and delete. Editing an entry keeps its name (the name is its identity).
 */
export function AgentMemoryPanel({
  address,
  items: initialItems,
  enabled: initialEnabled,
  showToggle = false,
}: {
  address: Address;
  items: AgentMemoryItem[];
  /** Only meaningful with showToggle (the settings page owns the switch). */
  enabled?: boolean;
  showToggle?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [items, setItems] = useState(initialItems);
  const [enabled, setEnabled] = useState(initialEnabled ?? true);
  useEffect(() => setItems(initialItems), [initialItems]);
  useEffect(() => setEnabled(initialEnabled ?? true), [initialEnabled]);
  const [editing, setEditing] = useState<string | null>(null); // entry name, or "__new__"
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [result, setResult] = useState<string | null>(null);
  const flash = (msg: string) => {
    setResult(msg);
    setTimeout(() => setResult(null), 3000);
  };

  const startEdit = (item?: AgentMemoryItem) => {
    setEditing(item ? item.name : "__new__");
    setDraft(item ? { name: item.name, description: item.description, kind: item.kind, body: item.body } : EMPTY_DRAFT);
  };

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(() => saveAgentMemoryAction(address, draft), (msg) => flash(`❌ ${msg}`));
      if (!r.ok) return;
      if (r.value.success) {
        flash("✅ 已保存");
        setEditing(null);
        router.refresh();
      } else {
        flash(`❌ ${r.value.message ?? "保存失败"}`);
      }
    });
  };

  const handleDelete = (name: string) => {
    startTransition(async () => {
      const r = await runAction(() => deleteAgentMemoryAction(address, name), (msg) => flash(`❌ ${msg}`));
      if (!r.ok) return;
      if (r.value.success) {
        setItems((prev) => prev.filter((item) => item.name !== name));
        flash("✅ 已删除");
        router.refresh();
      } else {
        flash(`❌ ${r.value.message ?? "删除失败"}`);
      }
    });
  };

  const handleToggle = (next: boolean) => {
    startTransition(async () => {
      const r = await runAction(() => setAgentMemoryEnabledAction(next), (msg) => flash(`❌ ${msg}`));
      if (!r.ok) return;
      if (r.value.success) {
        setEnabled(next);
        flash(next ? "✅ 记忆已开启" : "✅ 记忆已关闭");
        router.refresh();
      } else {
        flash(`❌ ${r.value.message ?? "保存失败"}`);
      }
    });
  };

  const editor = (
    <div className="push-form agent-memory-editor">
      <div className="push-field">
        <label className="push-label">名称（英文短横线，例如 no-2025-year）</label>
        <input
          type="text"
          className="setting-control"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          disabled={editing !== "__new__"}
          aria-label="记忆名称"
        />
      </div>
      <div className="push-field">
        <label className="push-label">一句话摘要</label>
        <input
          type="text"
          className="setting-control"
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          aria-label="记忆摘要"
        />
      </div>
      <div className="push-field">
        <label className="push-label">类型</label>
        <select
          className="setting-control"
          value={draft.kind}
          onChange={(event) => setDraft({ ...draft, kind: event.target.value as Kind })}
          aria-label="记忆类型"
        >
          {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </div>
      <div className="push-field">
        <label className="push-label">正文（写上依据，例如「搜 X 0 条结果」）</label>
        <textarea
          className="setting-textarea"
          rows={4}
          value={draft.body}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          aria-label="记忆正文"
        />
      </div>
      <div className="service-actions">
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        <button type="button" className="secondary-button" onClick={() => setEditing(null)} disabled={isPending}>
          <X size={14} aria-hidden />
          取消
        </button>
        {result ? (
          <span className="panel-note" role="status">
            {result}
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="agent-memory">
      {showToggle ? (
        <div className="service-actions">
          <label className="service-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => handleToggle(event.target.checked)}
              disabled={isPending}
              aria-label="启用 agent 记忆"
            />
            启用 agent 记忆（每次获取前读取、结束后复盘写入）
          </label>
        </div>
      ) : null}
      {items.length === 0 && editing === null ? <p className="panel-note">还没有记忆。agent 在获取后觉得值得记的，会写在这里。</p> : null}
      <ul className="agent-memory-list">
        {items.map((item) =>
          editing === item.name ? (
            <li key={item.name}>{editor}</li>
          ) : (
            <li key={item.name} className="agent-memory-item">
              <div className="agent-memory-head">
                <span className="agent-memory-kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
                <strong className="agent-memory-name">{item.name}</strong>
                <span className="panel-note">{item.description}</span>
              </div>
              <p className="agent-memory-body">{item.body}</p>
              <div className="agent-memory-foot">
                <span className="panel-note">
                  更新于 {item.updatedAt.slice(0, 10)}
                  {item.lastUsedAt ? ` · 最近使用 ${item.lastUsedAt.slice(0, 10)}` : ""}
                </span>
                <button type="button" className="secondary-button" onClick={() => startEdit(item)} disabled={isPending} aria-label={`编辑 ${item.name}`}>
                  <Pencil size={14} aria-hidden />
                  编辑
                </button>
                <button type="button" className="secondary-button" onClick={() => handleDelete(item.name)} disabled={isPending} aria-label={`删除 ${item.name}`}>
                  <Trash2 size={14} aria-hidden />
                  删除
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      {editing === "__new__" ? (
        editor
      ) : (
        <div className="service-actions">
          <button type="button" className="secondary-button" onClick={() => startEdit()} disabled={isPending}>
            <Plus size={14} aria-hidden />
            手动添加
          </button>
          {result ? <span className="panel-note">{result}</span> : null}
        </div>
      )}
    </div>
  );
}
