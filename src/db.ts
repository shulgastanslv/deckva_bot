import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl });

export type PendingTemplate = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  keyMoments: string[];
  submittedAt: Date | null;
  aspectRatio: string;
  authorName: string | null;
  authorEmail: string;
  slideCount: number;
};

export type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  unlimitedGenerations: boolean;
  generationsUsedToday: number;
  banned: boolean;
  lastSignedInAt: Date | null;
  createdAt: Date;
  projectCount: number;
};

type PendingRow = {
  id: string;
  title: string;
  communityCategory: string | null;
  communityDescription: string | null;
  communityKeyMoments: string[] | null;
  communityUpdatedAt: Date | null;
  aspectRatio: string;
  author_name: string | null;
  author_email: string;
  slide_count: number;
};

function mapPending(row: PendingRow): PendingTemplate {
  return {
    id: row.id,
    title: row.title,
    category: row.communityCategory,
    description: row.communityDescription,
    keyMoments: row.communityKeyMoments ?? [],
    submittedAt: row.communityUpdatedAt,
    aspectRatio: row.aspectRatio,
    authorName: row.author_name,
    authorEmail: row.author_email,
    slideCount: Number(row.slide_count),
  };
}

export async function countPending(): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM "Project"
     WHERE "communityStatus" = 'PENDING'::"CommunityStatus"
       AND "trashedAt" IS NULL`,
  );
  return rows[0]?.count ?? 0;
}

export async function listPending(
  limit: number,
  offset: number,
): Promise<PendingTemplate[]> {
  const { rows } = await pool.query<PendingRow>(
    `SELECT
       p.id,
       p.title,
       p."communityCategory",
       p."communityDescription",
       p."communityKeyMoments",
       p."communityUpdatedAt",
       p."aspectRatio",
       u.name AS author_name,
       u.email AS author_email,
       (SELECT COUNT(*)::int FROM "Slide" s WHERE s."projectId" = p.id) AS slide_count
     FROM "Project" p
     JOIN "User" u ON u.id = p."userId"
     WHERE p."communityStatus" = 'PENDING'::"CommunityStatus"
       AND p."trashedAt" IS NULL
     ORDER BY p."communityUpdatedAt" DESC NULLS LAST, p."updatedAt" DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapPending);
}

/** Same fields the web admin writes in setCommunityReviewStatus. */
export async function reviewTemplate(
  id: string,
  status: "APPROVED" | "REJECTED",
): Promise<string | null> {
  const approved = status === "APPROVED";
  const { rows } = await pool.query<{ title: string }>(
    `UPDATE "Project"
     SET "communityStatus" = $2::"CommunityStatus",
         "isPublic" = $3,
         "publishedAt" = CASE WHEN $3 THEN NOW() ELSE "publishedAt" END,
         "updatedAt" = NOW()
     WHERE id = $1
       AND "communityStatus" = 'PENDING'::"CommunityStatus"
       AND "trashedAt" IS NULL
     RETURNING title`,
    [id, status, approved],
  );
  return rows[0]?.title ?? null;
}

export async function countUsers(): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "User"`,
  );
  return rows[0]?.count ?? 0;
}

export type UserBrief = {
  id: string;
  email: string;
  name: string | null;
  role: string;
};

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  unlimitedGenerations: boolean;
  generationsUsedToday: number;
  bannedAt: Date | null;
  lastSignedInAt: Date | null;
  createdAt: Date;
  project_count: number;
};

const userColumns = `
  u.id,
  u.email,
  u.name,
  u.role::text AS role,
  u."unlimitedGenerations",
  u."generationsUsedToday",
  u."bannedAt",
  u."lastSignedInAt",
  u."createdAt",
  (
    SELECT COUNT(*)::int
    FROM "Project" p
    WHERE p."userId" = u.id AND p."trashedAt" IS NULL
  ) AS project_count
`;

function mapUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    unlimitedGenerations: row.unlimitedGenerations,
    generationsUsedToday: Number(row.generationsUsedToday),
    banned: row.bannedAt != null,
    lastSignedInAt: row.lastSignedInAt,
    createdAt: row.createdAt,
    projectCount: Number(row.project_count),
  };
}

export async function listUsers(
  limit: number,
  offset: number,
): Promise<AdminUser[]> {
  const { rows } = await pool.query<UserRow>(
    `SELECT ${userColumns}
     FROM "User" u
     ORDER BY u."createdAt" DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapUser);
}

export async function getUser(id: string): Promise<AdminUser | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT ${userColumns}
     FROM "User" u
     WHERE u.id = $1`,
    [id],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function searchUsers(
  query: string,
  limit: number,
): Promise<UserBrief[]> {
  const trimmed = query.trim();
  if (trimmed.includes("@")) {
    const exact = await pool.query<UserBrief>(
      `SELECT id, email, name, role::text AS role
       FROM "User"
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [trimmed],
    );
    if (exact.rows[0]) return exact.rows;
  }

  const { rows } = await pool.query<UserBrief>(
    `SELECT id, email, name, role::text AS role
     FROM "User"
     WHERE email ILIKE $1 ESCAPE '\\'
        OR name ILIKE $1 ESCAPE '\\'
     ORDER BY "createdAt" DESC
     LIMIT $2`,
    [likePattern(trimmed), limit],
  );
  return rows;
}

async function otherAdmins(
  client: Pool | PoolClient,
  id: string,
  unbannedOnly: boolean,
): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM "User"
     WHERE role = 'ADMIN'::"UserRole"
       AND id <> $1
       AND ($2::boolean = false OR "bannedAt" IS NULL)`,
    [id, unbannedOnly],
  );
  return rows[0]?.count ?? 0;
}

/** True when the change would leave the site without an admin. */
export async function locksOutAdmins(
  user: AdminUser,
  action: "ban" | "demote" | "delete",
): Promise<boolean> {
  if (user.role !== "ADMIN") return false;
  if (action === "ban") {
    if (user.banned) return false;
    return (await otherAdmins(pool, user.id, true)) === 0;
  }
  return (await otherAdmins(pool, user.id, false)) === 0;
}

export async function setBanned(
  id: string,
  banned: boolean,
): Promise<AdminUser | null> {
  const { rowCount } = await pool.query(
    `UPDATE "User"
     SET "bannedAt" = CASE WHEN $2 THEN NOW() ELSE NULL END,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [id, banned],
  );
  if (!rowCount) return null;
  return getUser(id);
}

export async function setRole(
  id: string,
  role: "USER" | "ADMIN",
): Promise<AdminUser | null> {
  const { rowCount } = await pool.query(
    `UPDATE "User"
     SET role = $2::"UserRole",
         "unlimitedGenerations" = CASE
           WHEN $2 = 'ADMIN' THEN true
           ELSE "unlimitedGenerations"
         END,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [id, role],
  );
  if (!rowCount) return null;
  return getUser(id);
}

export async function setUnlimited(
  id: string,
  unlimited: boolean,
): Promise<AdminUser | null> {
  const { rowCount } = await pool.query(
    `UPDATE "User"
     SET "unlimitedGenerations" = $2,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [id, unlimited],
  );
  if (!rowCount) return null;
  return getUser(id);
}

export type DeleteResult =
  | { ok: true; email: string }
  | { ok: false; reason: "missing" | "last-admin" | "linked" };

export async function deleteUser(id: string): Promise<DeleteResult> {
  const user = await getUser(id);
  if (!user) return { ok: false, reason: "missing" };
  if (await locksOutAdmins(user, "delete")) {
    return { ok: false, reason: "last-admin" };
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM "User" WHERE id = $1`, [id]);
    if (!rowCount) return { ok: false, reason: "missing" };
    return { ok: true, email: user.email };
  } catch (err) {
    if (isForeignKeyError(err)) return { ok: false, reason: "linked" };
    throw err;
  }
}

function isForeignKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23503"
  );
}

export async function newsAuthor(): Promise<{ id: string; label: string } | null> {
  const { rows } = await pool.query<{ id: string; label: string }>(
    `SELECT id, COALESCE(NULLIF(btrim(name), ''), email) AS label
     FROM "User"
     WHERE role = 'ADMIN'::"UserRole"
     ORDER BY "createdAt" ASC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** News row plus one inbox notification per user, same as the web admin. */
export async function publishNews(
  title: string,
  body: string,
): Promise<{ recipients: number; author: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const author = await client.query<{ id: string; label: string }>(
      `SELECT id, COALESCE(NULLIF(btrim(name), ''), email) AS label
       FROM "User"
       WHERE role = 'ADMIN'::"UserRole"
       ORDER BY "createdAt" ASC
       LIMIT 1`,
    );
    const authorRow = author.rows[0];
    if (!authorRow) {
      throw new Error("NO_ADMIN");
    }

    const newsId = randomUUID();
    await client.query(
      `INSERT INTO "News" (id, title, body, "createdAt", "authorId")
       VALUES ($1, $2, $3, NOW(), $4)`,
      [newsId, title, body, authorRow.id],
    );

    const users = await client.query<{ id: string }>(`SELECT id FROM "User"`);
    const userIds = users.rows.map((row) => row.id);
    for (let index = 0; index < userIds.length; index += 100) {
      const slice = userIds.slice(index, index + 100);
      const params: unknown[] = [title, body, newsId];
      const tuples = slice.map((userId) => {
        const idParam = params.push(randomUUID());
        const userParam = params.push(userId);
        return `($${idParam}, $1, $2, NOW(), $${userParam}, $3)`;
      });
      await client.query(
        `INSERT INTO "Notification" (id, title, body, "createdAt", "userId", "newsId")
         VALUES ${tuples.join(", ")}`,
        params,
      );
    }

    await client.query("COMMIT");
    return { recipients: userIds.length, author: authorRow.label };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function notifyUser(
  userId: string,
  title: string,
  body: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO "Notification" (id, title, body, "createdAt", "userId")
     SELECT $1, $2, $3, NOW(), id
     FROM "User"
     WHERE id = $4`,
    [randomUUID(), title, body, userId],
  );
  return (rowCount ?? 0) > 0;
}
