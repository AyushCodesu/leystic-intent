import { expect, it } from "vitest";
import { describeDb, makeProject, makeUser } from "./fixtures/db";
import {
  getFounderConfirmations,
  getLatestInspectionSnapshot,
  saveFounderConfirmation,
  saveWebsiteInspection,
} from "@/lib/gaps/store";
import type { PageInventoryResult } from "@/lib/gaps/types";

describeDb("gaps database persistence and tenant isolation", () => {
  it("persists inspection snapshots and isolates data between projects", async () => {
    const user = await makeUser();
    const projectA = await makeProject(user.id, { name: "Project A", url: "https://project-a.com" });
    const projectB = await makeProject(user.id, { name: "Project B", url: "https://project-b.com" });

    const inventoryA: PageInventoryResult = {
      status: "success",
      pagesFound: 2,
      pagesCrawled: 2,
      sitemapFound: true,
      error: null,
      pages: [
        {
          url: "https://project-a.com/",
          canonicalUrl: "https://project-a.com/",
          title: "Project A Home",
          description: "Home of A",
          h1: "Welcome to A",
          headings: ["Features", "Pricing"],
          path: "/",
          crawledAt: new Date(),
        },
        {
          url: "https://project-a.com/features/forms",
          canonicalUrl: "https://project-a.com/features/forms",
          title: "A Forms Feature",
          description: "Forms of A",
          h1: "Form Builder",
          headings: ["Integrations"],
          path: "/features/forms",
          crawledAt: new Date(),
        },
      ],
    };

    await saveWebsiteInspection(projectA.id, "https://project-a.com", inventoryA);

    // Snapshot for Project A should have 2 pages
    const snapshotA = await getLatestInspectionSnapshot(projectA.id);
    expect(snapshotA.status).toBe("success");
    expect(snapshotA.pagesCount).toBe(2);
    expect(snapshotA.pages[0].title).toBe("Project A Home");

    // Snapshot for Project B must be empty (tenant isolation)
    const snapshotB = await getLatestInspectionSnapshot(projectB.id);
    expect(snapshotB.status).toBe("not_inspected");
    expect(snapshotB.pagesCount).toBe(0);

    // Save founder confirmation for Project A
    await saveFounderConfirmation(
      projectA.id,
      "dg_forms",
      "confirmed_match",
      "https://project-a.com/features/forms",
      "Confirmed by founder",
    );

    const confsA = await getFounderConfirmations(projectA.id);
    expect(confsA.get("dg_forms")?.status).toBe("confirmed_match");
    expect(confsA.get("dg_forms")?.confirmedPageUrl).toBe("https://project-a.com/features/forms");

    // Project B must have zero confirmations
    const confsB = await getFounderConfirmations(projectB.id);
    expect(confsB.size).toBe(0);

    // Verify preservation: if subsequent inspection fails for Project A, previous snapshot remains
    const failedInventory: PageInventoryResult = {
      status: "failed",
      pagesFound: 0,
      pagesCrawled: 0,
      sitemapFound: false,
      error: "Temporary network timeout",
      pages: [],
    };
    await saveWebsiteInspection(projectA.id, "https://project-a.com", failedInventory);

    const preservedSnapshot = await getLatestInspectionSnapshot(projectA.id);
    expect(preservedSnapshot.pagesCount).toBe(2);
    expect(preservedSnapshot.error).toBe("Temporary network timeout");
    expect(preservedSnapshot.pages[0].title).toBe("Project A Home");
  });
});
