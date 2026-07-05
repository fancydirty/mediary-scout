import {
  getWorkflowRepository,
  getAccountScopedSettings,
  getLlmConfig,
  getQualityPreference,
  getPreferredLanguage,
  getDailySweepTime,
  getProwlarrConfig,
  LLM_BASE_URL_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  QUALITY_PREFERENCE_SETTING_KEY,
  PREFERRED_LANGUAGE_SETTING_KEY,
  DAILY_SWEEP_TIME_SETTING_KEY,
  PANSOU_BASE_URL_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  TMDB_API_KEY_SETTING_KEY,
} from "../workflow-runtime";

const PUSH_CHANNEL_KEYS = ["bark", "serverchan", "wecom", "webhook"] as const;
type PushChannelKey = (typeof PUSH_CHANNEL_KEYS)[number];

export interface AgentConfigView {
  llm: { baseURL: string | null; modelId: string | null; apiKey: string | null };
  qualityPreference: string | undefined;
  preferredLanguage: string | undefined;
  dailySweepTime: string;
  pansouBaseUrl: string | null;
  prowlarr: { baseURL: string; apiKey: string | null } | null;
  tmdbApiKey: string | null;
  push: Partial<Record<PushChannelKey, string>>;
  storages: Array<{ id: string; brand: string; name: string | null }>;
}

/** Mask a secret: keep last 4 chars if long enough, else full mask. */
export function maskSecret(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) {
    return null;
  }
  return v.length > 8 ? `***${v.slice(-4)}` : "***";
}

/** True when a write value looks like a masked placeholder being echoed back. */
export function isMaskedPlaceholder(value: string): boolean {
  return value.includes("***");
}

export async function readAgentConfig(accountId: string): Promise<AgentConfigView> {
  const settings = getAccountScopedSettings(accountId);
  const repository = getWorkflowRepository();
  const [llm, quality, language, sweepTime, prowlarr, storageRows] = await Promise.all([
    getLlmConfig(settings),
    getQualityPreference(settings),
    getPreferredLanguage(settings),
    getDailySweepTime(repository),
    getProwlarrConfig(settings),
    repository.listConnectedStorages(accountId),
  ]);
  const pansou = (await settings.getSetting(PANSOU_BASE_URL_SETTING_KEY))?.trim() || null;
  const tmdbKey = (await settings.getSetting(TMDB_API_KEY_SETTING_KEY))?.trim() || null;

  const push: Partial<Record<PushChannelKey, string>> = {};
  for (const key of PUSH_CHANNEL_KEYS) {
    const value = (await settings.getSetting(`push_${key}`))?.trim();
    if (value) {
      const masked = maskSecret(value);
      if (masked) {
        push[key] = masked;
      }
    }
  }

  return {
    llm: {
      baseURL: llm.baseURL ?? null,
      modelId: llm.modelId ?? null,
      apiKey: maskSecret(llm.apiKey),
    },
    qualityPreference: quality,
    preferredLanguage: language,
    dailySweepTime: sweepTime,
    pansouBaseUrl: pansou,
    prowlarr: prowlarr.baseURL
      ? { baseURL: prowlarr.baseURL, apiKey: maskSecret(prowlarr.apiKey) }
      : null,
    tmdbApiKey: maskSecret(tmdbKey),
    push,
    storages: storageRows.map((row) => ({
      id: row.id,
      brand: row.provider,
      name: row.label,
    })),
  };
}

export interface AgentConfigWriteInput {
  llm?: { baseURL?: string; modelId?: string; apiKey?: string };
  qualityPreference?: string;
  preferredLanguage?: string;
  dailySweepTime?: string;
  pansouBaseUrl?: string;
  prowlarr?: { baseURL?: string; apiKey?: string };
  tmdbApiKey?: string;
  push?: Partial<Record<PushChannelKey, string>>;
}

export type AgentConfigWriteResult =
  | { ok: true; updated: string[] }
  | { ok: false; field: string; message: string };

const QUALITY_VALUES = ["high", "medium"];

/**
 * Partial update: only provided fields are written. Secret fields reject
 * masked placeholders ("***…") so an agent echoing back a read value can
 * never destroy the real secret.
 */
export async function writeAgentConfig(
  accountId: string,
  input: AgentConfigWriteInput,
): Promise<AgentConfigWriteResult> {
  const repository = getWorkflowRepository();
  const updated: string[] = [];

  const setAccount = (key: string, value: string) =>
    repository.setAccountSetting(accountId, key, value);

  const secretFields: Array<[string | undefined, string]> = [
    [input.llm?.apiKey, "llm.apiKey"],
    [input.prowlarr?.apiKey, "prowlarr.apiKey"],
    [input.tmdbApiKey, "tmdbApiKey"],
    ...Object.entries(input.push ?? {}).map(
      ([key, value]) => [value, `push.${key}`] as [string | undefined, string],
    ),
  ];
  for (const [value, field] of secretFields) {
    if (value !== undefined && isMaskedPlaceholder(value)) {
      return {
        ok: false,
        field,
        message: `拒绝写入脱敏占位值（含 ***）。请提供完整的新值，或不传该字段保持不变。`,
      };
    }
  }

  if (input.qualityPreference !== undefined) {
    if (!QUALITY_VALUES.includes(input.qualityPreference)) {
      return {
        ok: false,
        field: "qualityPreference",
        message: `无效画质偏好，可选：${QUALITY_VALUES.join(" / ")}`,
      };
    }
    await setAccount(QUALITY_PREFERENCE_SETTING_KEY, input.qualityPreference);
    updated.push("qualityPreference");
  }

  if (input.preferredLanguage !== undefined) {
    await setAccount(PREFERRED_LANGUAGE_SETTING_KEY, input.preferredLanguage.trim());
    updated.push("preferredLanguage");
  }

  if (input.dailySweepTime !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(input.dailySweepTime)) {
      return { ok: false, field: "dailySweepTime", message: "时间格式应为 HH:MM" };
    }
    const [hours, minutes] = input.dailySweepTime.split(":").map(Number);
    if (hours! > 23 || minutes! > 59) {
      return { ok: false, field: "dailySweepTime", message: "时间超出范围" };
    }
    await repository.setSetting(DAILY_SWEEP_TIME_SETTING_KEY, input.dailySweepTime);
    updated.push("dailySweepTime");
  }

  if (input.llm) {
    if (input.llm.baseURL !== undefined) {
      const trimmed = input.llm.baseURL.trim();
      if (trimmed && !/^https?:\/\//.test(trimmed)) {
        return { ok: false, field: "llm.baseURL", message: "baseURL 需以 http(s):// 开头" };
      }
      await setAccount(LLM_BASE_URL_SETTING_KEY, trimmed);
      updated.push("llm.baseURL");
    }
    if (input.llm.modelId !== undefined) {
      await setAccount(LLM_MODEL_ID_SETTING_KEY, input.llm.modelId.trim());
      updated.push("llm.modelId");
    }
    if (input.llm.apiKey !== undefined) {
      await setAccount(LLM_API_KEY_SETTING_KEY, input.llm.apiKey.trim());
      updated.push("llm.apiKey");
    }
  }

  if (input.pansouBaseUrl !== undefined) {
    const trimmed = input.pansouBaseUrl.trim();
    if (trimmed && !/^https?:\/\//.test(trimmed)) {
      return { ok: false, field: "pansouBaseUrl", message: "baseURL 需以 http(s):// 开头" };
    }
    await setAccount(PANSOU_BASE_URL_SETTING_KEY, trimmed);
    updated.push("pansouBaseUrl");
  }

  if (input.prowlarr) {
    if (input.prowlarr.baseURL !== undefined) {
      const trimmed = input.prowlarr.baseURL.trim();
      if (trimmed && !/^https?:\/\//.test(trimmed)) {
        return { ok: false, field: "prowlarr.baseURL", message: "baseURL 需以 http(s):// 开头" };
      }
      await setAccount(PROWLARR_BASE_URL_SETTING_KEY, trimmed);
      updated.push("prowlarr.baseURL");
    }
    if (input.prowlarr.apiKey !== undefined) {
      await setAccount(PROWLARR_API_KEY_SETTING_KEY, input.prowlarr.apiKey.trim());
      updated.push("prowlarr.apiKey");
    }
  }

  if (input.tmdbApiKey !== undefined) {
    await setAccount(TMDB_API_KEY_SETTING_KEY, input.tmdbApiKey.trim());
    updated.push("tmdbApiKey");
  }

  if (input.push) {
    for (const key of PUSH_CHANNEL_KEYS) {
      const value = input.push[key];
      if (value !== undefined) {
        await setAccount(`push_${key}`, value.trim());
        updated.push(`push.${key}`);
      }
    }
  }

  return { ok: true, updated };
}
