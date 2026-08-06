import {
  FallbackResourceProvider,
  PanSouResourceProvider,
  type ResourceProvider,
  type ResourceType,
} from "@media-track/workflow";

/** 官方公共 PanSou。用户留空时的默认，也是自建源挂掉时的退路。 */
export const DEFAULT_PANSOU_BASE_URL = "https://so.252035.xyz";

/**
 * 解析「用户自己的源」：DB 设置 > env PANSOU_BASE_URL > 空。
 *
 * env 这一层不能省。compose 用 `PANSOU_BASE_URL: http://pansou` 把自带容器注进来，
 * 而 DB 设置是空的；只读 DB 会让每个自部署实例悄悄改用官方公共源 —— 既没了自带
 * 容器，也没了 fallback 兜底，正是本 PR 要消灭的那类静默降级。
 *
 * 注意与 getPanSouBaseUrl 的分工：那个函数把三层压成「最终用哪个地址」，这里要的是
 * 「用户到底配没配」—— 空串与官方地址必须可区分，否则 hasCustom 判不出来。
 */
export function resolveUserPanSouBaseUrl(
  dbValue: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return dbValue?.trim() || env.PANSOU_BASE_URL?.trim() || "";
}

/**
 * 装配 PanSou 检索链。抽成纯函数是为了让「什么时候该包 fallback」可以被单测
 * —— 这个判断以前埋在 getWorkerResourceProvider 里，测不到。
 *
 * 只有用户配了**自己的**源才需要 fallback：没配（或配的就是官方源）时无处可退，
 * 包一层只会让每次失败白跑两遍。
 */
export function buildPanSouProviderChain(input: {
  userBaseURL: string;
  allowedTypes: ResourceType[];
}): ResourceProvider {
  const user = input.userBaseURL.trim();
  const hasCustom = user !== "" && user !== DEFAULT_PANSOU_BASE_URL;
  if (!hasCustom) {
    return new PanSouResourceProvider({
      baseURL: user || DEFAULT_PANSOU_BASE_URL,
      allowedTypes: input.allowedTypes,
    });
  }
  return new FallbackResourceProvider({
    primary: {
      name: "自建搜索源",
      provider: new PanSouResourceProvider({ baseURL: user, allowedTypes: input.allowedTypes }),
    },
    secondary: {
      name: "官方搜索源",
      provider: new PanSouResourceProvider({
        baseURL: DEFAULT_PANSOU_BASE_URL,
        allowedTypes: input.allowedTypes,
      }),
    },
  });
}
