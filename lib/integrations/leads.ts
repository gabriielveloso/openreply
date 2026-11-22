import { prisma } from "@/lib/db/client";
import { hashRecipientId } from "@/lib/tracking/server";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

/** A DM that delivered the campaign material: one lead event for the Da Vinci lead list. */
export type LeadSend = {
  id: string;
  campaignId: string;
  campaignName: string;
  commenterId: string;
  commenterName: string | null;
  commentText: string;
  origin: "comentario" | "direct";
  sentAt: string;
  clicked: boolean;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const COMMENT_MAX = 500;

/** Opaque cursor: base64url of "<dmSentAt ISO>|<DmLog id>". Exclusive: the next page starts after it. */
export function encodeLeadCursor(sentAt: Date, id: string): string {
  return Buffer.from(`${sentAt.toISOString()}|${id}`).toString("base64url");
}

function decodeLeadCursor(cursor: string): { sentAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf("|");
  const sentAt = new Date(sep > 0 ? decoded.slice(0, sep) : "");
  if (sep <= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(decoded) || Number.isNaN(sentAt.getTime())) throw new ApiError("Invalid cursor");
  return { sentAt, id: decoded.slice(sep + 1) };
}

/**
 * SENT DMs from comments and from the keyword sent by direct message, oldest first by (dmSentAt, id).
 * Button-tap sends (the opening-DM reveal) are not lead events and are left out.
 */
export async function listLeadSends(context: ServiceContext, opts: { after?: string; limit?: number }) {
  requireScope(context, "logs:read");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT) || 1));
  const cursor = opts.after ? decodeLeadCursor(opts.after) : null;
  const serverTime = new Date().toISOString();
  const rows = await prisma.dmLog.findMany({
    where: {
      workspaceId: context.workspaceId,
      status: "SENT",
      dmSentAt: { not: null },
      NOT: [{ commentText: "(button tap)" }, { commentId: { startsWith: "reveal:" } }],
      ...(cursor
        ? { OR: [{ dmSentAt: { gt: cursor.sentAt } }, { dmSentAt: cursor.sentAt, id: { gt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ dmSentAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true, automationId: true, commenterId: true, commenterName: true, commentText: true,
      commentId: true, dmSentAt: true, automation: { select: { name: true } },
    },
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last?.dmSentAt ? encodeLeadCursor(last.dmSentAt, last.id) : null;

  const clickedKeys = new Set<string>();
  if (page.length) {
    const hashes = new Map(page.map(row => [hashRecipientId(row.commenterId), row.commenterId]));
    const clicks = await prisma.linkClick.findMany({
      where: {
        workspaceId: context.workspaceId,
        automationId: { in: [...new Set(page.map(row => row.automationId))] },
        recipientHash: { in: [...hashes.keys()] },
      },
      select: { automationId: true, recipientHash: true },
    });
    for (const click of clicks) clickedKeys.add(`${click.automationId}|${hashes.get(click.recipientHash!)}`);
  }

  const items: LeadSend[] = page.map(row => ({
    id: row.id,
    campaignId: row.automationId,
    campaignName: row.automation.name,
    commenterId: row.commenterId,
    commenterName: row.commenterName,
    commentText: row.commentText.slice(0, COMMENT_MAX),
    origin: row.commentId.startsWith("dm:") ? "direct" : "comentario",
    sentAt: row.dmSentAt!.toISOString(),
    clicked: clickedKeys.has(`${row.automationId}|${row.commenterId}`),
  }));
  return { items, nextCursor, serverTime };
}

/**
 * People who clicked a DM link since `since` (click time), as (campaign, commenter) pairs. The click only stores
 * hashRecipientId(commenterId), so the commenters of the clicked campaigns are hashed here to match.
 */
export async function listNewClicks(context: ServiceContext, since: Date) {
  requireScope(context, "logs:read");
  const serverTime = new Date().toISOString();
  const clicks = await prisma.linkClick.findMany({
    where: { workspaceId: context.workspaceId, createdAt: { gt: since }, recipientHash: { not: null } },
    select: { automationId: true, recipientHash: true },
  });
  if (!clicks.length) return { items: [], serverTime };
  const senders = await prisma.dmLog.findMany({
    where: { workspaceId: context.workspaceId, status: "SENT", automationId: { in: [...new Set(clicks.map(c => c.automationId))] } },
    distinct: ["automationId", "commenterId"],
    select: { automationId: true, commenterId: true },
  });
  const byHash = new Map(senders.map(s => [`${s.automationId}|${hashRecipientId(s.commenterId)}`, s]));
  const seen = new Set<string>();
  const items: { campaignId: string; commenterId: string }[] = [];
  for (const click of clicks) {
    const sender = byHash.get(`${click.automationId}|${click.recipientHash}`);
    const key = sender ? `${sender.automationId}|${sender.commenterId}` : "";
    if (!sender || seen.has(key)) continue;
    seen.add(key);
    items.push({ campaignId: sender.automationId, commenterId: sender.commenterId });
  }
  return { items, serverTime };
}
