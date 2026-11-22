import { authenticateService } from "@/lib/integrations/auth";
import { ApiError, apiError, checkOrigin } from "@/lib/integrations/http";
import { listNewClicks } from "@/lib/integrations/leads";

/** GET /api/v1/leads/clicks?since=<ISO>: (campaign, commenter) pairs with a DM link click after `since`. */
export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const raw = new URL(request.url).searchParams.get("since");
    const since = raw === null ? null : new Date(raw);
    if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw) || !since || Number.isNaN(since.getTime())) throw new ApiError("Invalid since");
    const data = await listNewClicks(context, since);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
