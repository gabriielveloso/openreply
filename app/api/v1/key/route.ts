import { authenticateService } from "@/lib/integrations/auth";
import { apiError, checkOrigin } from "@/lib/integrations/http";
import { getKeyInfo } from "@/lib/integrations/key-info";

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    return Response.json({ data: await getKeyInfo(context) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
