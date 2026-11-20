import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: { findUnique: vi.fn(), update: vi.fn() },
  campaigns: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  accounts: { findMany: vi.fn() },
  media: vi.fn(), context: vi.fn(), eval: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: { serviceKey: state.keys, automation: state.campaigns, instagramAccount: state.accounts } }));
vi.mock("@/lib/instagram/provider", () => ({ getUserMedia: state.media, createInstagramContext: state.context }));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = state.eval; listenerCount() { return 1; } } }));

import { shortcodeFromUrl } from "../lib/integrations/post-link";
import { PATCH, POST } from "../app/api/v1/campaigns/route";

const token = `orp_${"a".repeat(43)}`;
const writeKey = { id: "key", name: "Da Vinci", workspaceId: "workspace", scopes: ["campaigns:read", "campaigns:write", "logs:read"], expiresAt: new Date("2099-01-01"), revokedAt: null };
const account = { id: "acc1", workspaceId: "workspace", provider: "META", accessToken: "enc", instagramId: "17841", metaLogin: "UNIFIED", zernioAccountId: null };
const body = {
  name: "Como achar criadores virais", postUrl: "https://www.instagram.com/p/DfyLyZUFlRs/?igsh=x",
  keywords: ["CRIADORES"], dmMessage: "Aqui está o passo a passo", destinationUrl: "https://example.com/guia",
  externalRef: "davinci:post-7",
};
const call = (method: "POST" | "PATCH", payload: unknown, query = "") =>
  (method === "POST" ? POST : PATCH)(new Request(`https://example.test/api/v1/campaigns${query}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  state.keys.findUnique.mockResolvedValue(writeKey);
  state.keys.update.mockResolvedValue(writeKey);
  state.eval.mockResolvedValue(1);
  state.campaigns.findFirst.mockResolvedValue(null);
  state.campaigns.create.mockImplementation(async ({ data }) => ({ id: "c1", name: data.name, isActive: data.isActive, postId: data.postId, postUrl: data.postUrl }));
  state.campaigns.updateMany.mockResolvedValue({ count: 1 });
  state.accounts.findMany.mockResolvedValue([account]);
  state.context.mockResolvedValue({ provider: "META" });
  state.media.mockResolvedValue([{ id: "media-1", permalink: "https://www.instagram.com/reel/DfyLyZUFlRs/" }]);
});

describe("shortcodeFromUrl", () => {
  it.each([
    ["https://www.instagram.com/p/DfyLyZUFlRs/", "DfyLyZUFlRs"],
    ["https://instagram.com/reel/DfyLyZUFlRs?igsh=abc", "DfyLyZUFlRs"],
    ["https://www.instagram.com/rumoaomilhao/reel/DfyLyZUFlRs", "DfyLyZUFlRs"],
    ["https://www.instagram.com/reels/DfyLyZUFlRs/", "DfyLyZUFlRs"],
    ["https://www.instagram.com/tv/DfyLyZUFlRs/", "DfyLyZUFlRs"],
    ["https://example.com/p/x", null],
    ["nao é url", null],
  ])("%s → %s", (url, expected) => expect(shortcodeFromUrl(url)).toBe(expected));
});

describe("create campaign", () => {
  it("creates a campaign bound to the matching post", async () => {
    const response = await call("POST", body);
    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ id: "c1", created: true, postId: "media-1" });
    const { data } = state.campaigns.create.mock.calls[0][0];
    expect(data).toMatchObject({
      workspaceId: "workspace", instagramAccountId: "acc1", goal: "davinci:post-7",
      postId: "media-1", postUrl: "https://www.instagram.com/reel/DfyLyZUFlRs/",
      keywords: ["CRIADORES"], dmMessage: "Aqui está o passo a passo", linkButtonLabel: "Abrir link",
      openingDmEnabled: false, requireFollow: false, isActive: true, wholeWordMatch: true,
      pendingNextReel: false, matchAnyPost: false, publicReplyEnabled: false,
    });
    expect(data.trackedLinks.create[0].destinationUrl).toBe("https://example.com/guia");
    expect(state.media).toHaveBeenCalledWith({ context: { provider: "META" }, limit: 50 });
  });
  it("adds the public reply and omits the link button without a destination", async () => {
    await call("POST", { ...body, destinationUrl: "", publicReply: "Te mandei no direct" });
    const { data } = state.campaigns.create.mock.calls[0][0];
    expect(data).toMatchObject({ publicReplyEnabled: true, publicReplyMessages: ["Te mandei no direct"], publicReplyMessage: "Te mandei no direct", linkButtonLabel: null });
    expect(data.trackedLinks).toBeUndefined();
  });
  it("returns the existing campaign for the same externalRef", async () => {
    state.campaigns.findFirst.mockResolvedValue({ id: "c0", name: "x", isActive: true, postId: "media-1", postUrl: "u" });
    const response = await call("POST", body);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: "c0", created: false });
    expect(state.campaigns.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "workspace", goal: "davinci:post-7" });
    expect(state.campaigns.create).not.toHaveBeenCalled();
    expect(state.media).not.toHaveBeenCalled();
  });
  it("rejects a post that is not on the account", async () => {
    state.media.mockResolvedValue([{ id: "other", permalink: "https://www.instagram.com/p/OUTRO/" }]);
    const response = await call("POST", body);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("Post not found on the connected account");
  });
  it("requires campaigns:write", async () => {
    state.keys.findUnique.mockResolvedValue({ ...writeKey, scopes: ["campaigns:read"] });
    expect((await call("POST", body)).status).toBe(403);
  });
  it("asks for the account when the workspace has two", async () => {
    state.accounts.findMany.mockResolvedValue([account, { ...account, id: "acc2" }]);
    const response = await call("POST", body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Choose an Instagram account");
    state.campaigns.create.mockClear();
    expect((await call("POST", { ...body, instagramAccountId: "acc2" })).status).toBe(201);
    expect(state.campaigns.create.mock.calls[0][0].data.instagramAccountId).toBe("acc2");
  });
  it("needs a connected account", async () => {
    state.accounts.findMany.mockResolvedValue([]);
    expect((await (await call("POST", body)).json()).error).toBe("Connect Instagram before creating campaigns");
  });
  it.each([
    { ...body, externalRef: "post-7" },
    { ...body, externalRef: "davinci:post-0" },
    { ...body, postUrl: "https://example.com/p/x" },
    { ...body, keywords: [] },
    { ...body, dmMessage: "" },
    { ...body, extra: true },
  ])("rejects invalid input %#", async payload => {
    expect((await call("POST", payload)).status).toBe(400);
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });
});

describe("pause and resume", () => {
  it("pauses within the workspace", async () => {
    const response = await call("PATCH", { isActive: false }, "?id=c1");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ id: "c1", isActive: false });
    expect(state.campaigns.updateMany).toHaveBeenCalledWith({ where: { id: "c1", workspaceId: "workspace" }, data: { isActive: false } });
  });
  it("returns 404 for a foreign campaign", async () => {
    state.campaigns.updateMany.mockResolvedValue({ count: 0 });
    expect((await call("PATCH", { isActive: true }, "?id=foreign")).status).toBe(404);
  });
  it("accepts only isActive", async () => {
    expect((await call("PATCH", { isActive: true, name: "x" }, "?id=c1")).status).toBe(400);
    expect((await call("PATCH", { isActive: true })).status).toBe(400);
  });
  it("requires campaigns:write", async () => {
    state.keys.findUnique.mockResolvedValue({ ...writeKey, scopes: ["campaigns:read"] });
    expect((await call("PATCH", { isActive: false }, "?id=c1")).status).toBe(403);
  });
});
