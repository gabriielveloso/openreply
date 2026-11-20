import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";
import { generateReportShareSlug } from "@/lib/reports/share";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";
import { shortcodeFromUrl } from "./post-link";

// Button title for the tracked link; the campaigns created this way are for a
// Portuguese-speaking audience.
const LINK_BUTTON_LABEL = "Abrir link";
// How many recent posts are searched for the one the link points at.
const MEDIA_SEARCH_LIMIT = 50;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(100),
  postUrl: z.string().url().refine(url => shortcodeFromUrl(url) !== null, "Invalid post URL"),
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  dmMessage: z.string().trim().min(1).max(1000),
  destinationUrl: z.union([z.string().url(), z.literal("")]).optional(),
  publicReply: z.string().trim().min(1).max(1000).optional(),
  instagramAccountId: z.string().min(1).max(100).optional(),
  // Marks the caller's own record so a retry returns the same campaign.
  externalRef: z.string().regex(/^davinci:post-[1-9]\d{0,14}$/),
}).strict();

const resultSelect = { id: true, name: true, isActive: true, postId: true, postUrl: true } as const;

/**
 * Creates an active campaign bound to one published post: link as a button,
 * no opening DM, no follow gate. Returns the existing campaign when one with
 * the same externalRef already exists in the workspace.
 */
export async function createCampaign(context: ServiceContext, raw: unknown) {
  requireScope(context, "campaigns:write");
  const parsed = createCampaignSchema.safeParse(raw);
  if (!parsed.success) {
    const postIssue = parsed.error.issues.some(issue => issue.path[0] === "postUrl");
    throw new ApiError(postIssue ? "Invalid post URL" : "Invalid campaign input");
  }
  const input = parsed.data;
  const { workspaceId } = context;

  const existing = await prisma.automation.findFirst({ where: { workspaceId, goal: input.externalRef }, select: resultSelect });
  if (existing) return { created: false, campaign: existing };

  const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId } });
  if (accounts.length === 0) throw new ApiError("Connect Instagram before creating campaigns");
  const account = input.instagramAccountId
    ? accounts.find(a => a.id === input.instagramAccountId)
    : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) {
    throw new ApiError(input.instagramAccountId ? "Instagram account not found" : "Choose an Instagram account",
      input.instagramAccountId ? 404 : 400);
  }

  const wanted = shortcodeFromUrl(input.postUrl);
  const media = await getUserMedia({ context: await createInstagramContext(account), limit: MEDIA_SEARCH_LIMIT });
  const post = media.find(item => item.permalink && shortcodeFromUrl(item.permalink) === wanted);
  if (!post) throw new ApiError("Post not found on the connected account", 422);

  const links = buildInitialCampaignLinks({ workspaceId, primaryUrl: input.destinationUrl || null });
  const campaign = await prisma.automation.create({
    data: {
      workspaceId, instagramAccountId: account.id, name: input.name, goal: input.externalRef,
      postId: post.id, postUrl: post.permalink ?? input.postUrl, pendingNextReel: false, matchAnyPost: false,
      keywords: input.keywords, matchAnyWord: false, wholeWordMatch: true, dmTriggerEnabled: false,
      dmMessage: input.dmMessage, openingDmEnabled: false, requireFollow: false, followUpEnabled: false,
      linkButtonLabel: input.destinationUrl ? LINK_BUTTON_LABEL : null,
      publicReplyEnabled: Boolean(input.publicReply),
      publicReplyMessages: input.publicReply ? [input.publicReply] : [],
      publicReplyMessage: input.publicReply ?? null,
      isActive: true, reportShareSlug: generateReportShareSlug(),
      ...(links.length > 0 ? { trackedLinks: { create: links } } : {}),
    },
    select: resultSelect,
  });
  return { created: true, campaign };
}
