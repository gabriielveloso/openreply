import { prisma } from "@/lib/db/client";
import { ApiError } from "./http";
import type { ServiceContext } from "./auth";

/** The calling key's own metadata, so a client can warn before it expires. */
export async function getKeyInfo(context: ServiceContext) {
  const key = await prisma.serviceKey.findUnique({
    where: { id: context.keyId },
    select: { name: true, scopes: true, expiresAt: true },
  });
  if (!key) throw new ApiError("Invalid or expired service key", 401);
  return { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt.toISOString() };
}
