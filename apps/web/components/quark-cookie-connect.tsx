"use client";

import { CloudFamilyCookieConnect } from "./cloud-family-cookie-connect";

/**
 * 夸克手动 cookie 连接 —— 扫码登录(QuarkQrConnect)的折叠回退。用户从夸克 web
 * 请求头复制 Cookie(需含 httpOnly 的 __pus,document.cookie 抓不全)粘贴进来。
 * 组件本体与 UC 共用(同族协议),这里只固定品牌。
 */
export function QuarkCookieConnect() {
  return <CloudFamilyCookieConnect brand="quark" />;
}
