import { prisma } from "@/lib/db/client";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

const summarySelect = {
  id: true, name: true, goal: true, instagramAccountId: true, isActive: true,
  postId: true, postUrl: true, pendingNextReel: true, matchAnyPost: true,
  keywords: true, matchAnyWord: true, dmMessage: true, createdAt: true, updatedAt: true,
} as const;

type Totals = { sent: number; failed: number; skipped: number; clicks: number };
const emptyTotals = (): Totals => ({ sent: 0, failed: 0, skipped: 0, clicks: 0 });

function addStatus(totals: Totals, status: string, count: number) {
  if (status === "SENT") totals.sent += count;
  else if (status === "FAILED") totals.failed += count;
  else if (status.startsWith("SKIPPED_")) totals.skipped += count;
}

/** Campaign summaries plus all-time totals, from two grouped queries for the whole page. */
export async function listCampaigns(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  const campaigns = await prisma.automation.findMany({
    where: { workspaceId: context.workspaceId }, select: summarySelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100,
  });
  const totals = new Map(campaigns.map(c => [c.id, emptyTotals()]));
  if (campaigns.length) {
    const where = { workspaceId: context.workspaceId, automationId: { in: campaigns.map(c => c.id) } };
    const [statuses, clicks] = await Promise.all([
      prisma.dmLog.groupBy({ by: ["automationId", "status"], where, _count: { _all: true } }),
      prisma.linkClick.groupBy({ by: ["automationId"], where, _count: { _all: true } }),
    ]);
    for (const row of statuses) { const t = totals.get(row.automationId); if (t) addStatus(t, row.status, row._count._all); }
    for (const row of clicks) { const t = totals.get(row.automationId); if (t) t.clicks += row._count._all; }
  }
  return campaigns.map(c => ({ ...c, totals: totals.get(c.id) ?? emptyTotals() }));
}

/** The last 50 sends of one campaign, without recipient ids. */
export async function getCampaignLogs(context: ServiceContext, id: string) {
  requireScope(context, "logs:read");
  const campaign = await prisma.automation.findFirst({ where: { id, workspaceId: context.workspaceId }, select: { id: true } });
  if (!campaign) throw new ApiError("Campaign not found", 404);
  const logs = await prisma.dmLog.findMany({
    where: { workspaceId: context.workspaceId, automationId: id },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50,
    select: { id: true, commenterName: true, commentText: true, status: true, errorMessage: true, createdAt: true, dmSentAt: true },
  });
  return logs.map(log => ({ ...log, errorMessage: log.errorMessage ? log.errorMessage.slice(0, 200) : null }));
}

export async function getCampaign(context: ServiceContext, id: string) {
  requireScope(context, "campaigns:read");
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: {
      ...summarySelect, wholeWordMatch: true, dmTriggerEnabled: true,
      openingDmEnabled: true, openingDmMessage: true, openingDmButtonLabel: true,
      linkButtonLabel: true, requireFollow: true, followPromptMessage: true,
      followPromptButtonLabel: true, followUpEnabled: true, followUpMessage: true,
      followUpDelayMinutes: true, publicReplyEnabled: true, publicReplyMessage: true,
      publicReplyMessages: true,
      trackedLinks: {
        where: { workspaceId: context.workspaceId }, orderBy: TRACKED_LINK_ORDER,
        select: { destinationUrl: true, label: true, position: true },
      },
    },
  });
  if (!campaign) throw new ApiError("Campaign not found", 404);
  const [primary, secondary] = campaign.trackedLinks;
  return {
    ...campaign, trackedDestinationUrl: primary?.destinationUrl ?? null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
  };
}

export async function getCampaignStats(context: ServiceContext, id: string, since?: Date) {
  await getCampaign(context, id);
  const where = { workspaceId: context.workspaceId, automationId: id, ...(since ? { createdAt: { gte: since } } : {}) };
  const [statuses, rawClicks] = await Promise.all([
    prisma.dmLog.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.linkClick.count({ where }),
  ]);
  return { campaignId: id, statuses, rawClicks, note: "Raw link requests include previews and repeated clicks; not unique recipients." };
}

/** Pause or resume one campaign of the key's workspace; nothing else changes. */
export async function setCampaignActive(context: ServiceContext, id: string, isActive: boolean) {
  requireScope(context, "campaigns:write");
  const result = await prisma.automation.updateMany({ where: { id, workspaceId: context.workspaceId }, data: { isActive } });
  if (!result.count) throw new ApiError("Campaign not found", 404);
  return { id, isActive };
}
