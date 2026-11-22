import { authenticateService } from "@/lib/integrations/auth";
import { ApiError, apiError, checkOrigin } from "@/lib/integrations/http";
import { listLeadSends } from "@/lib/integrations/leads";

/** GET /api/v1/leads?after=<cursor>&limit=<n>: SENT DMs (lead events), oldest first, paginated. */
export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const after = url.searchParams.get("after") ?? undefined;
    if (after !== undefined && (after.length === 0 || after.length > 300)) throw new ApiError("Invalid cursor");
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isFinite(limit)) throw new ApiError("Invalid limit");
    const data = await listLeadSends(context, { after, limit });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
