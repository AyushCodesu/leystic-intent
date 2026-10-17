import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { testDatabaseUrl } from "./testDatabase";

/**
 * Runs once before the workers start: creates the `_test` database when it
 * is missing and brings it up to date, so `npm test` needs nothing beyond the
 * .env a dev server already has.
 */
export default async function setup(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const url = testDatabaseUrl(process.env);
  if (!url || url === process.env.TEST_DATABASE_URL) {
    if (url) {
      await migrateDatabase(url);
      await trimDatabase(url);
    }
    return;
  }
  try {
    const target = new URL(url);
    const name = target.pathname.replace(/^\//, "");
    const admin = new URL(process.env.DATABASE_URL!);
    const sql = postgres(admin.toString(), { max: 1, connect_timeout: 1 });
    try {
      const [row] = await sql`select 1 from pg_database where datname = ${name}`;
      if (!row) {
        await sql.unsafe(`create database "${name.replaceAll('"', '""')}"`);
      }
    } finally {
      await sql.end().catch(() => {});
    }
    await migrateDatabase(url);
    await trimDatabase(url);
  } catch (err) {
    // If database connection fails (no local Postgres running), skip gracefully so unit tests can run
    console.warn("Test database not reachable; skipping database setup:", (err as Error).message);
  }
}

async function migrateDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}

/**
 * Runs the retention passes once, on the real clock, before any worker starts.
 * The retention tests run theirs as of a time long past, so that they take
 * only their own rows (tests/retention.test.ts), and so nothing else clears
 * the old posts, finished jobs and X rows every run leaves behind: a local
 * `_test` database kept for months would only grow. Nothing runs beside this
 * yet, so the real clock is safe here.
 *
 * The passes reach the database through db(), which builds its pool from
 * DATABASE_URL, the app's own database in this process. The client is handed
 * to db() before the passes are loaded, so they only ever see `url`.
 */
async function trimDatabase(url: string): Promise<void> {
  const holder = globalThis as typeof globalThis & { __lurkDb?: unknown };
  const sql = postgres(url, { max: 1 });
  holder.__lurkDb = drizzle(sql, { schema });
  try {
    const { deleteExpiredPosts, pruneFinishedJobs } = await import("@/lib/retention");
    const { deleteExpiredXData } = await import("@/lib/x/retention");
    await deleteExpiredPosts();
    await pruneFinishedJobs();
    await deleteExpiredXData();
  } finally {
    delete holder.__lurkDb;
    await sql.end();
  }
}
