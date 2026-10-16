import { existsSync } from "node:fs";
import { PAID_KEYS, testDatabaseUrl } from "./testDatabase";

/**
 * The database-backed tests read DATABASE_URL, which lives in .env like every
 * other local secret. Without this they silently skip on a machine that has a
 * database, which is the same as not having written them.
 *
 * .env also holds the app's own database and its paid model keys, so both are
 * swapped out before any test imports the app: the tests write to a `_test`
 * database (tests/testDatabase.ts) and see no key that could be billed.
 */
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const url = testDatabaseUrl(process.env);
const hasRealDb = Boolean(url);
if (url) {
  process.env.DATABASE_URL = url;
} else {
  // Config requires DATABASE_URL to parse. Provide a test placeholder when no DB is configured.
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/mock_test_db";
}
process.env.TEST_DB_AVAILABLE = hasRealDb ? "true" : "false";
for (const key of PAID_KEYS) {
  delete process.env[key];
}
process.env.RUN_SCHEDULER = "false";
/**
 * The config refuses to load without an encryption key, and every test that
 * reaches the database loads it. Any 32 bytes will do where .env has no key,
 * as in CI; a test that needs a particular key stubs it with vi.stubEnv.
 */
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");
