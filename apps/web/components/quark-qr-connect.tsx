"use client";

import { CloudFamilyQrConnect } from "./cloud-family-qr-connect";

/**
 * 夸克扫码登录。相位机与 UC 共用(同族 CAS 协议),这里只固定品牌。
 */
export function QuarkQrConnect() {
  return <CloudFamilyQrConnect brand="quark" />;
}
