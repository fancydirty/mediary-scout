import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  credential: "ic_revoked" as string | null,
  email: "owner@example.com" as string | null,
  order: { orderId: "ord_1", checkoutUrl: "https://pay.example/ord_1" } as { orderId: string; checkoutUrl: string } | null,
  accountAnswer: "unauthorized" as "unauthorized" | "linked",
}));

vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));
vi.mock("../../lib/workflow-runtime", () => ({
  getCurrentAccountSummary: vi.fn(async () => ({ isOwner: true })),
  hasLoginPassword: vi.fn(async () => true),
  isMultiUserEnabled: vi.fn(() => false),
}));
vi.mock("../../lib/remote-access", () => ({
  resolveInstanceTunnelToken: vi.fn(async () => undefined),
  resolveInstanceConnectHostname: vi.fn(async () => undefined),
  resolveRemoteAccessState: vi.fn(async () => ({ kind: "not_provisioned" })),
  passwordSetupHref: vi.fn(() => "/login"),
  formatLastSeen: vi.fn(() => null),
  CONNECT_SITE_URL: "https://mediaryconnect.app",
  consoleUrl: vi.fn(() => "https://mediaryconnect.app/console"),
}));
vi.mock("../password-change-form", () => ({ PasswordChangeForm: () => null }));
vi.mock("./remote-access-test-button", () => ({ RemoteAccessTestButton: () => null }));
vi.mock("./connect-wizard", () => ({ ConnectWizard: () => null }));
vi.mock("../../app/connect-actions", () => ({
  connectAccountAction: vi.fn(async () => {
    if (state.accountAnswer === "linked") {
      return {
        state: "linked",
        account: { email: "owner@example.com", active: true, expiresAt: null, endpoint: null, checkoutOpen: true, tiers: [] },
      };
    }
    // What the real action does on a 401: forget the credential, its email and its order.
    state.credential = null;
    state.email = null;
    state.order = null;
    return { state: "unlinked" };
  }),
}));
vi.mock("../../lib/connect-link-store", () => ({
  getConnectInstanceCredential: vi.fn(async () => state.credential),
  getConnectAccountEmail: vi.fn(async () => state.email),
  getConnectLinkPending: vi.fn(async () => null),
  getConnectPendingOrder: vi.fn(async () => state.order),
}));

import { ConnectWizard } from "./connect-wizard";
import { RemoteAccessSection } from "./remote-access-section";

function findWizardProps(node: ReactNode): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findWizardProps(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (element.type === ConnectWizard) return element.props;
  return findWizardProps(element.props.children);
}

beforeEach(() => {
  state.credential = "ic_revoked";
  state.email = "owner@example.com";
  state.order = { orderId: "ord_1", checkoutUrl: "https://pay.example/ord_1" };
  state.accountAnswer = "unauthorized";
});

describe("RemoteAccessSection", () => {
  it("shows the wizard as not linked when Connect just rejected the stored credential", async () => {
    const tree = await RemoteAccessSection({ searchParams: Promise.resolve({}) });
    const props = findWizardProps(tree);
    expect(props).toMatchObject({ linked: false, email: null, pendingOrder: null });
  });

  it("passes the stored link through when Connect still accepts it", async () => {
    state.accountAnswer = "linked";
    const tree = await RemoteAccessSection({ searchParams: Promise.resolve({}) });
    const props = findWizardProps(tree);
    expect(props).toMatchObject({
      linked: true,
      email: "owner@example.com",
      pendingOrder: { orderId: "ord_1", checkoutUrl: "https://pay.example/ord_1" },
    });
  });
});
