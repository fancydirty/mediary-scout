"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import {
  DEFAULT_SELECTION_PREFERENCE,
  SELECTION_PREFERENCE_MAX_LENGTH,
  SELECTION_PREFERENCE_PRESETS,
} from "@media-track/workflow/selection-preference";
import { saveSelectionPreferenceAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const PRESET_TEXTS = new Set(SELECTION_PREFERENCE_PRESETS.map((p) => p.text));

export function SelectionPreferenceForm({ initial, saved }: { initial: string; saved: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(saved);

  const trimmed = value.trim();
  const isCustomEdited = trimmed.length > 0 && !PRESET_TEXTS.has(trimmed);
  const showEditGuidance = focused || isCustomEdited;
  const overLimit = trimmed.length > SELECTION_PREFERENCE_MAX_LENGTH;

  const handleSave = (nextValue = value) => {
    startTransition(async () => {
      const r = await runAction(
        () => saveSelectionPreferenceAction(nextValue),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3500);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        setIsSaved(true);
      }
      setResult(res.success ? "✅ 已保存" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3500);
    });
  };

  const applyPreset = (text: string) => {
    setValue(text);
    setResult(null);
  };

  return (
    <div className="push-form selection-pref-form">
      {!isSaved ? (
        <p className="panel-note selection-pref-unsaved">
          这段模板已填好但还没生效 —— 点「保存」后，之后所有的获取、补缺和换源都会按它挑片。
        </p>
      ) : null}
      <div className="selection-pref-presets" role="group" aria-label="选源预设模板">
        {SELECTION_PREFERENCE_PRESETS.map((preset) => {
          const active = trimmed === preset.text;
          return (
            <button
              key={preset.id}
              type="button"
              className={`selection-pref-chip${active ? " is-active" : ""}`}
              onClick={() => applyPreset(preset.text)}
              disabled={isPending}
            >
              {preset.label}
            </button>
          );
        })}
        {trimmed !== DEFAULT_SELECTION_PREFERENCE ? (
          <button
            type="button"
            className="selection-pref-reset"
            onClick={() => applyPreset(DEFAULT_SELECTION_PREFERENCE)}
            disabled={isPending}
          >
            <RotateCcw size={12} aria-hidden />
            恢复默认模板
          </button>
        ) : null}
      </div>

      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={4}
        maxLength={SELECTION_PREFERENCE_MAX_LENGTH + 50}
        className="setting-textarea selection-pref-textarea"
        placeholder="留空则不注入额外选源要求，仅按基础入库规则获取"
        aria-label="选源要求"
      />

      <div className="selection-pref-meta">
        <span className={`selection-pref-count${overLimit ? " is-over" : ""}`}>
          {trimmed.length} / {SELECTION_PREFERENCE_MAX_LENGTH}
        </span>
      </div>

      {showEditGuidance ? (
        <div className="selection-pref-caution" role="note">
          <TriangleAlert size={14} aria-hidden className="selection-pref-caution-icon" />
          <span>
            建议用「优先 HDR10，避开杜比视界，单部电影尽量小于 25GB」这类相对优先级写法。系统始终遵循覆盖优先（没有理想版本时退取能播的版本入库，不留缺），随意填写自相矛盾或不够完备的规则可能导致 AI 选片表现变差。
          </span>
        </div>
      ) : null}

      <div className="service-actions">
        <button
          type="button"
          className="primary-button"
          onClick={() => handleSave(value)}
          disabled={isPending || overLimit}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
    </div>
  );
}
