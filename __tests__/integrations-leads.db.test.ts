import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { listLeadSends } from "../lib/integrations/leads";
import { hashRecipientId } from "../lib/tracking/server";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `leads_${randomBytes(4).toString("hex")}`;
let sql: Client;
const context = { workspaceId: "workspace", keyId: "key", scopes: ["logs:read"] };

let seq = 0;
async function send(data: {
  automationId?: string; workspaceId?: string; commenterId: string; commenterName?: string;
  commentText?: string; commentId?: string; status?: "SENT" | "FAILED"; dmSentAt?: Date | null;
}) {
  const workspaceId = data.workspaceId ?? "workspace";
  seq += 1;
  return state.db.dmLog.create({ data: {
    id: `log_${String(seq).padStart(3, "0")}`,
    workspaceId, automationId: data.automationId ?? "campaign_a", instagramAccountId: `account_${workspaceId}`,
    commenterId: data.commenterId, commenterName: data.commenterName ?? data.commenterId,
    commentText: data.commentText ?? "CANDY", commentId: data.commentId ?? `comment_${seq}`,
    status: data.status ?? "SENT", dmSentAt: data.dmSentAt === undefined ? new Date(Date.UTC(2026, 10, 1, 12, seq)) : data.dmSentAt,
  } });
}

async function readAll(limit: number) {
  const ids: string[] = [];
  let after: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await listLeadSends(context, { after, limit });
    ids.push(...page.items.map(item => item.id));
    if (!page.nextCursor) return ids;
    after = page.nextCursor;
  }
  throw new Error("paginação não terminou");
}

describe.skipIf(!databaseUrl)("leads pela chave de serviço, em PostgreSQL de verdade", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) await sql.query(readFileSync(path.join(root, dir.name, "migration.sql"), "utf8"));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "leads@example.test" } });
    for (const id of ["workspace", "other"]) {
      await state.db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
      await state.db.instagramAccount.create({ data: { id: `account_${id}`, workspaceId: id, instagramId: id, username: id, accessToken: "local-only" } });
    }
    for (const [id, workspaceId, name] of [["campaign_a", "workspace", "Candy"], ["campaign_b", "workspace", "Royal"], ["campaign_x", "other", "Outro"]]) {
      await state.db.automation.create({ data: { id, workspaceId, instagramAccountId: `account_${workspaceId}`, name, keywords: ["CANDY"], dmMessage: "Toma", isActive: true } });
    }
  }, 60_000);
  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("devolve só SENT de comentário e direct, do workspace, em ordem", async () => {
    const comment = await send({ commenterId: "c1", commenterName: "fulana" });
    const direct = await send({ commenterId: "c2", commentId: "dm:mid-1", commentText: "quero o guia" });
    await send({ commenterId: "c3", status: "FAILED" });
    await send({ commenterId: "c4", commentText: "(button tap)", commentId: "reveal:c4" });
    await send({ commenterId: "c5", workspaceId: "other", automationId: "campaign_x" });
    await send({ commenterId: "c6", dmSentAt: null });
    const page = await listLeadSends(context, {});
    expect(page.items.map(i => [i.id, i.origin])).toEqual([[comment.id, "comentario"], [direct.id, "direct"]]);
    expect(page.items[0]).toMatchObject({ campaignId: "campaign_a", campaignName: "Candy", commenterId: "c1", commenterName: "fulana", commentText: "CANDY", clicked: false });
    expect(page.nextCursor).toBeNull();
    expect(new Date(page.serverTime).getTime()).toBeGreaterThan(0);
    await state.db.dmLog.deleteMany({});
  });

  it("pagina sem perder nem repetir no mesmo dmSentAt", async () => {
    const same = new Date(Date.UTC(2026, 10, 2, 9, 0));
    const created = [
      await send({ commenterId: "p1" }),
      await send({ commenterId: "p2", dmSentAt: same }),
      await send({ commenterId: "p3", dmSentAt: same }),
      await send({ commenterId: "p4", dmSentAt: same }),
      await send({ commenterId: "p5", dmSentAt: new Date(Date.UTC(2026, 10, 3)) }),
    ];
    expect(await readAll(2)).toEqual(created.map(c => c.id));
    expect(await readAll(1)).toEqual(created.map(c => c.id));
    await state.db.dmLog.deleteMany({});
  });

  it("clicked pelo hash do commenterId na mesma campanha", async () => {
    await state.db.trackedLink.create({ data: { id: "link_a", workspaceId: "workspace", automationId: "campaign_a", slug: "a", destinationUrl: "https://a.test" } });
    const inA = await send({ commenterId: "k1", automationId: "campaign_a" });
    const inB = await send({ commenterId: "k1", automationId: "campaign_b" });
    const other = await send({ commenterId: "k2", automationId: "campaign_a" });
    await state.db.linkClick.create({ data: { workspaceId: "workspace", automationId: "campaign_a", instagramAccountId: "account_workspace", trackedLinkId: "link_a", recipientHash: hashRecipientId("k1") } });
    const items = (await listLeadSends(context, {})).items;
    const clicked = Object.fromEntries(items.map(i => [i.id, i.clicked]));
    expect(clicked).toEqual({ [inA.id]: true, [inB.id]: false, [other.id]: false });
    await state.db.dmLog.deleteMany({});
  });

  it("cursor inválido, limite e escopo", async () => {
    await expect(listLeadSends(context, { after: "lixo" })).rejects.toMatchObject({ status: 400, message: "Invalid cursor" });
    await expect(listLeadSends({ ...context, scopes: ["campaigns:read"] }, {})).rejects.toMatchObject({ status: 403 });
    for (let i = 0; i < 3; i++) await send({ commenterId: `l${i}` });
    expect((await listLeadSends(context, { limit: 9999 })).items).toHaveLength(3);
    expect((await listLeadSends(context, { limit: 0 })).items).toHaveLength(1);
    await state.db.dmLog.deleteMany({});
  });

  it("corta o comentário em 500 caracteres", async () => {
    await send({ commenterId: "long", commentText: "x".repeat(800) });
    expect((await listLeadSends(context, {})).items[0].commentText).toHaveLength(500);
    await state.db.dmLog.deleteMany({});
  });
});
