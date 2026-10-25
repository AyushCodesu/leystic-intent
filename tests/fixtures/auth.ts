import { randomUUID } from "node:crypto";
import {
  globalRegistry,
  type TrustedAuthRecord,
  type SourceId,
} from "@/lib/sourcePolicy";

export type TestAuthorizedSource = "reddit" | "x" | "google_scraped_serp" | "all";

export interface InstalledTestAuth {
  cleanup: () => Promise<void>;
  redditRecordId?: string;
  xRecordId?: string;
  googleRecordId?: string;
}

export function createTestApprovedRecord(sourceId: SourceId, recordId?: string): TrustedAuthRecord {
  const effectiveDate = "2020-01-01T00:00:00.000Z";
  const nowStr = new Date().toISOString();

  if (sourceId === "reddit") {
    return {
      recordId: recordId ?? `REC-REDDIT-TEST-${randomUUID().slice(0, 8)}`,
      sourceId: "reddit",
      name: "Reddit Test Fixture",
      status: "APPROVED",
      authorizedPurposes: [
        "commercial_lead_generation",
        "competitor_intelligence",
        "seo_opportunity_discovery",
        "social_intent_monitoring",
      ],
      scopes: [
        "commercial_indexing",
        "search_discovery",
        "social_content_read",
        "comments_read",
        "profile_metadata_read",
      ],
      effectiveDate,
      expirationDate: null,
      evidenceReference: "CONTRACT-REDDIT-TEST-FIXTURE",
      approvalProvenance: {
        approvedBy: "test_suite",
        reviewedAt: nowStr,
        notes: "Approved fixture for automated testing",
      },
    };
  }

  if (sourceId === "x") {
    return {
      recordId: recordId ?? `REC-X-TEST-${randomUUID().slice(0, 8)}`,
      sourceId: "x",
      name: "X Test Fixture",
      status: "APPROVED",
      authorizedPurposes: [
        "social_intent_monitoring",
        "commercial_lead_generation",
        "competitor_intelligence",
      ],
      scopes: [
        "search_discovery",
        "social_content_read",
        "profile_metadata_read",
      ],
      effectiveDate,
      expirationDate: null,
      evidenceReference: "CONTRACT-X-TEST-FIXTURE",
      approvalProvenance: {
        approvedBy: "test_suite",
        reviewedAt: nowStr,
        notes: "Approved fixture for automated testing",
      },
    };
  }

  return {
    recordId: recordId ?? `REC-GOOGLE-SERP-TEST-${randomUUID().slice(0, 8)}`,
    sourceId: "google_scraped_serp",
    name: "Google Scraped SERP Test Fixture",
    status: "APPROVED",
    authorizedPurposes: [
      "seo_opportunity_discovery",
      "commercial_lead_generation",
      "competitor_intelligence",
    ],
    scopes: [
      "search_discovery",
      "commercial_indexing",
    ],
    effectiveDate,
    expirationDate: null,
    evidenceReference: "CONTRACT-GOOGLE-SERP-TEST-FIXTURE",
    approvalProvenance: {
      approvedBy: "test_suite",
      reviewedAt: nowStr,
      notes: "Approved fixture for automated testing",
    },
  };
}

export async function installTestAuthorizedSource(
  target: TestAuthorizedSource = "all",
  options?: { recordId?: string },
): Promise<InstalledTestAuth> {
  const originalEnv = {
    REDDIT_SOURCE_ENABLED: process.env.REDDIT_SOURCE_ENABLED,
    REDDIT_AUTH_RECORD_ID: process.env.REDDIT_AUTH_RECORD_ID,
    X_LEADS: process.env.X_LEADS,
    X_AUTH_RECORD_ID: process.env.X_AUTH_RECORD_ID,
    GOOGLE_SERP_SOURCE_ENABLED: process.env.GOOGLE_SERP_SOURCE_ENABLED,
    GOOGLE_SERP_AUTH_RECORD_ID: process.env.GOOGLE_SERP_AUTH_RECORD_ID,
  };

  const recordsToInject: TrustedAuthRecord[] = [];
  let redditRecordId: string | undefined;
  let xRecordId: string | undefined;
  let googleRecordId: string | undefined;

  if (target === "reddit" || target === "all") {
    const record = createTestApprovedRecord("reddit", options?.recordId);
    redditRecordId = record.recordId;
    process.env.REDDIT_SOURCE_ENABLED = "true";
    process.env.REDDIT_AUTH_RECORD_ID = record.recordId;
    recordsToInject.push(record);
  }

  if (target === "x" || target === "all") {
    const record = createTestApprovedRecord("x", options?.recordId);
    xRecordId = record.recordId;
    process.env.X_LEADS = "true";
    process.env.X_AUTH_RECORD_ID = record.recordId;
    recordsToInject.push(record);
  }

  if (target === "google_scraped_serp" || target === "all") {
    const record = createTestApprovedRecord("google_scraped_serp", options?.recordId);
    googleRecordId = record.recordId;
    process.env.GOOGLE_SERP_SOURCE_ENABLED = "true";
    process.env.GOOGLE_SERP_AUTH_RECORD_ID = record.recordId;
    recordsToInject.push(record);
  }

  const currentStore = globalRegistry.getStore();
  for (const r of recordsToInject) {
    try {
      await currentStore.saveRecord(r, {
        id: `seed_${randomUUID().slice(0, 8)}`,
        recordId: r.recordId,
        action: "APPROVE",
        performedBy: "test_suite",
        actorRole: "compliance_officer",
        evidenceReference: r.evidenceReference,
        reason: "Test fixture authorization",
        previousStatus: null,
        newStatus: r.status,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // ignore
    }
    globalRegistry.__testOnlyInjectRecord(r);
  }

  if (process.env.TEST_DB_AVAILABLE === "true") {
    try {
      const { db } = await import("@/db");
      const { sourceAuthRecords } = await import("@/db/schema/sourceAuth");
      for (const r of recordsToInject) {
        await db()
          .insert(sourceAuthRecords)
          .values({
            recordId: r.recordId,
            sourceId: r.sourceId,
            name: r.name,
            status: r.status,
            authorizedPurposes: r.authorizedPurposes,
            scopes: r.scopes,
            effectiveDate: new Date(r.effectiveDate),
            expirationDate: r.expirationDate ? new Date(r.expirationDate) : null,
            evidenceReference: r.evidenceReference,
            approvalProvenance: r.approvalProvenance,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: sourceAuthRecords.recordId,
            set: {
              status: r.status,
              authorizedPurposes: r.authorizedPurposes,
              scopes: r.scopes,
              updatedAt: new Date(),
            },
          });
      }
    } catch {
      // Database not reachable, ignore
    }
  }

  const cleanup = async () => {
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }

    for (const r of recordsToInject) {
      globalRegistry.__testOnlyRemoveRecord(r.recordId);
      if (typeof currentStore.deleteRecord === "function") {
        await currentStore.deleteRecord(r.recordId).catch(() => {});
      }
    }

    if (process.env.TEST_DB_AVAILABLE === "true") {
      try {
        const { db } = await import("@/db");
        const { sourceAuthRecords } = await import("@/db/schema/sourceAuth");
        const { inArray } = await import("drizzle-orm");
        const ids = recordsToInject.map((r) => r.recordId);
        if (ids.length > 0) {
          await db().delete(sourceAuthRecords).where(inArray(sourceAuthRecords.recordId, ids)).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  };

  return {
    cleanup,
    redditRecordId,
    xRecordId,
    googleRecordId,
  };
}

export async function withTestAuthorizedSource<T>(
  target: TestAuthorizedSource,
  fn: () => Promise<T>,
): Promise<T> {
  const installed = await installTestAuthorizedSource(target);
  try {
    return await fn();
  } finally {
    await installed.cleanup();
  }
}
