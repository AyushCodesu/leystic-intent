import { afterEach, describe, expect, it } from "vitest";
import { xEnabledFor } from "@/lib/x/enabled";

/**
 * The X switch. X_LEADS is the kill switch, for everyone, and nobody who is not
 * signed in has X. And while X is off for a caller, the public API shows none
 * of X's limits: a feature that ships dark stays dark.
 */
describe("the X leads switch", () => {
  const saved = { on: process.env.X_LEADS };
  afterEach(() => {
    process.env.X_LEADS = saved.on;
  });

  it.each([
    ["false", "u1", false],
    ["true", "u1", true],
    ["true", null, false],
  ] as const)("X_LEADS=%s for %s is %s", (on, user, expected) => {
    process.env.X_LEADS = on;
    expect(xEnabledFor(user)).toBe(expected);
  });

  it.skipIf(process.env.TEST_DB_AVAILABLE !== "true")("keeps X's limits out of /api/v1/me unless X is on for the caller", async () => {
    const { me } = await import("@/lib/api/handlers");
    const { TIERS } = await import("@/lib/tiers");
    const caller = {
      user: { id: "u1", email: null, createdAt: new Date(0) },
      tier: "free",
      selfHosted: false,
      limits: TIERS.free,
      keyPrefix: "lk_x",
      scopes: [],
      keyId: "00000000-0000-0000-0000-000000000000",
    } as unknown as Parameters<typeof me>[0];
    type Shown = Record<string, unknown> & { actions: { presses: Record<string, number> } };

    process.env.X_LEADS = "false";
    const off = (await me(caller)).limits as Shown;
    expect(off).not.toHaveProperty("x");
    expect(off.actions.presses).not.toHaveProperty("x_scan_now");
    expect(off.actions.presses.scan_now).toBe(0);
    expect(off.projects).toBe(2);
    expect(TIERS.free.x).toBeDefined();

    process.env.X_LEADS = "true";
    const on = (await me(caller)).limits as Shown;
    expect(on).toHaveProperty("x");
  });
});
