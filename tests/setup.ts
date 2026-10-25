import { existsSync } from "node:fs";
import net from "node:net";
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

function checkDatabaseReachable(dbUrl: string | undefined): Promise<boolean> {
  if (!dbUrl) return Promise.resolve(false);
  try {
    const parsed = new URL(dbUrl);
    const host = parsed.hostname || "localhost";
    const port = Number(parsed.port) || 5432;
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 200 });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
  } catch {
    return Promise.resolve(false);
  }
}

const isReachable = await checkDatabaseReachable(url);

if (url && isReachable) {
  process.env.DATABASE_URL = url;
  process.env.TEST_DB_AVAILABLE = "true";
} else {
  // Config requires DATABASE_URL to parse. Provide a test placeholder when no DB is configured.
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/mock_test_db";
  process.env.TEST_DB_AVAILABLE = "false";
}
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

/**
 * Outbound network safeguard: intercept unmocked HTTP requests to live provider endpoints
 * during automated testing. Tests must mock external providers explicitly.
 */
const BLOCKED_HOSTS = new Set([
  "openrouter.ai",
  "ai-gateway.vercel.sh",
  "api.anyapi.com",
  "api.twitter.com",
  "api.x.com",
  "twitter.com",
  "x.com",
]);

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let urlString = "";
    if (typeof input === "string") {
      urlString = input;
    } else if (input instanceof URL) {
      urlString = input.href;
    } else if (input && typeof input === "object" && "url" in input) {
      urlString = String((input as Request).url);
    }

    try {
      const parsed = new URL(urlString);
      for (const blocked of BLOCKED_HOSTS) {
        if (parsed.hostname === blocked || parsed.hostname.endsWith("." + blocked)) {
          throw new Error(
            `[Network Test Safeguard] Unmocked outbound request to '${parsed.hostname}' blocked during test execution. All external provider calls must be mocked in tests.`
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("[Network Test Safeguard]")) {
        throw err;
      }
    }

    return originalFetch(input, init);
  };
}
