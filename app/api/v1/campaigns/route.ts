import { z } from "zod";
import { authenticateService } from "@/lib/integrations/auth";
import { getCampaign, getCampaignLogs, getCampaignStats, listCampaigns, setCampaignActive } from "@/lib/integrations/campaigns";
import { createCampaign } from "@/lib/integrations/create-campaign";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

function parseSince(raw: string | null): Date | undefined {
  if (raw === null) return undefined;
  const since = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(since.getTime())) throw new ApiError("Invalid since");
  return since;
}

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id !== null && !z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Invalid campaign id");
    if (url.searchParams.has("stats") && !id) throw new ApiError("Campaign id required for stats");
    if (url.searchParams.has("logs") && !id) throw new ApiError("Campaign id required for logs");
    const since = parseSince(url.searchParams.get("since"));
    const data = !id ? await listCampaigns(context)
      : url.searchParams.has("logs") ? await getCampaignLogs(context, id)
      : url.searchParams.has("stats") ? await getCampaignStats(context, id, since)
      : await getCampaign(context, id);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const { created, campaign } = await createCampaign(context, await readJson(request));
    return Response.json({ data: { ...campaign, created } }, { status: created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

const activeSchema = z.object({ isActive: z.boolean() }).strict();

export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Invalid campaign id");
    const input = activeSchema.safeParse(await readJson(request));
    if (!input.success) throw new ApiError("Only isActive can be changed");
    const data = await setCampaignActive(context, id, input.data.isActive);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
