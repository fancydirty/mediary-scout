import { describe, expect, it } from "vitest";
import { deadLinkKey } from "../src/acquisition-v2/dead-links.js";
import {
  brandOfUrl,
  candidateDriveLabel,
  resourceLinkKey,
  storageProviderForResourceType,
} from "../src/acquisition-v2/resource-link.js";

describe("resourceLinkKey — a resource's link identity for rejections and recorded sources", () => {
  it("115 shares, magnets and 光鸭 shares: the same key dead-link tracking uses", () => {
    for (const url of [
      "https://115.com/s/sw3abcd1234?password=x1y2",
      `magnet:?xt=urn:btih:${"A".repeat(40)}&dn=x`,
      "https://www.guangyapan.com/s/AbCdEf123",
    ]) {
      expect(resourceLinkKey(url)).toBe(deadLinkKey(url)!.key);
    }
  });

  it("夸克 / 123 / 天翼 shares, which dead-link tracking leaves out, get a key of their own — the same share under any passcode or fragment", () => {
    expect(deadLinkKey("https://pan.quark.cn/s/1a2B3c4D")).toBeNull();
    expect(resourceLinkKey("https://pan.quark.cn/s/1a2B3c4D")).toBe("quark:1a2B3c4D");
    expect(resourceLinkKey("https://pan.quark.cn/s/1a2B3c4D?pwd=abcd#/list/share")).toBe("quark:1a2B3c4D");

    expect(resourceLinkKey("https://www.123pan.com/s/Ab-cD_12")).toBe("pan123:Ab-cD_12");
    expect(resourceLinkKey("https://www.123684.com/s/Ab-cD_12?pwd=x9")).toBe("pan123:Ab-cD_12");

    expect(resourceLinkKey("https://cloud.189.cn/t/QvEjYz3m")).toBe("tianyi:QvEjYz3m");
    expect(resourceLinkKey("https://cloud.189.cn/t/QvEjYz3m?accessCode=8fd2")).toBe("tianyi:QvEjYz3m");
    expect(resourceLinkKey("https://cloud.189.cn/web/share?code=QvEjYz3m&pwd=8fd2")).toBe("tianyi:QvEjYz3m");
  });

  it("different shares stay different; a link no drive transfers by has no key", () => {
    expect(resourceLinkKey("https://pan.quark.cn/s/aaaa1111")).not.toBe(resourceLinkKey("https://pan.quark.cn/s/bbbb2222"));
    expect(resourceLinkKey("https://example.com/The.Odyssey.2026.mkv")).toBeNull();
    expect(resourceLinkKey("")).toBeNull();
  });
});

describe("brandOfUrl / candidateDriveLabel / storageProviderForResourceType", () => {
  it("classifies all six drive share shapes plus magnet and rejects lookalike hosts", () => {
    expect(brandOfUrl("https://115.com/s/sw3abcd1234")).toBe("115");
    expect(brandOfUrl("https://115cdn.com/s/sw3abcd1234?password=x")).toBe("115");
    expect(brandOfUrl("https://anxia.com/s/sw3abcd1234")).toBe("115");
    expect(brandOfUrl("https://pan.quark.cn/s/1a2B3c4D")).toBe("quark");
    expect(brandOfUrl("https://drive.uc.cn/s/9z8Y7x6W")).toBe("uc");
    expect(brandOfUrl("https://www.123pan.com/s/Ab-cD_12")).toBe("123");
    expect(brandOfUrl("https://www.123684.com/s/Ab-cD_12")).toBe("123");
    expect(brandOfUrl("https://cloud.189.cn/t/QvEjYz3m")).toBe("tianyi");
    expect(brandOfUrl("https://www.guangyapan.com/s/AbCdEf123")).toBe("guangya");
    expect(brandOfUrl("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")).toBe("magnet");

    expect(brandOfUrl("https://evilpan.quark.cn/s/1a2B3c4D")).toBeNull();
    expect(brandOfUrl("https://attacker.com/115.com/s/sw3abcd1234")).toBeNull();
    expect(brandOfUrl("")).toBeNull();
  });

  it("maps candidate resource types to Chinese labels and storage providers", () => {
    expect(candidateDriveLabel("115")).toBe("115");
    expect(candidateDriveLabel("quark")).toBe("夸克");
    expect(candidateDriveLabel("uc")).toBe("UC");
    expect(candidateDriveLabel("123")).toBe("123");
    expect(candidateDriveLabel("tianyi")).toBe("天翼");
    expect(candidateDriveLabel("guangya")).toBe("光鸭");
    expect(candidateDriveLabel("magnet")).toBe("磁力");

    expect(storageProviderForResourceType("115")).toBe("pan115");
    expect(storageProviderForResourceType("123")).toBe("pan123");
    expect(storageProviderForResourceType("quark")).toBe("quark");
    expect(storageProviderForResourceType("magnet")).toBeNull();
  });
});
