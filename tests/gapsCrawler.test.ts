import { describe, expect, it } from "vitest";
import { crawlWebsiteInventory } from "@/lib/gaps/crawler";

describe("crawlWebsiteInventory", () => {
  it("crawls homepage and discovered pages with canonical deduplication", async () => {
    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "https://acme.com/robots.txt") {
        return new Response(
          "User-agent: *\nDisallow: /admin/\nSitemap: https://acme.com/sitemap.xml",
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }

      if (url === "https://acme.com/sitemap.xml") {
        return new Response(
          `<urlset>
            <url><loc>https://acme.com/</loc></url>
            <url><loc>https://acme.com/pricing</loc></url>
            <url><loc>https://acme.com/features/builder</loc></url>
            <url><loc>https://acme.com/admin/settings</loc></url>
          </urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }

      if (url === "https://acme.com/" || url === "https://acme.com") {
        return new Response(
          `<html><head><title>Acme Homepage</title><meta name="description" content="Homepage desc" /><link rel="canonical" href="https://acme.com/" /></head><body><h1>Welcome to Acme</h1><a href="/pricing">Pricing</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://acme.com/pricing") {
        return new Response(
          `<html><head><title>Pricing Plans</title><link rel="canonical" href="https://acme.com/pricing" /></head><body><h1>Transparent Pricing</h1><h2>Starter Plan</h2></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://acme.com/features/builder") {
        return new Response(
          `<html><head><title>Form Builder Feature</title><link rel="canonical" href="https://acme.com/features/builder" /></head><body><h1>Form Builder</h1><h2>Drag and Drop</h2></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const res = await crawlWebsiteInventory("https://acme.com", {
      fetchFn: mockFetch as unknown as typeof fetch,
      skipDnsCheck: true,
    });

    expect(res.status).toBe("success");
    expect(res.sitemapFound).toBe(true);
    expect(res.pagesCrawled).toBe(3); // homepage, pricing, features/builder (admin was disallowed)

    const home = res.pages.find((p) => p.path === "/");
    expect(home?.title).toBe("Acme Homepage");

    const pricing = res.pages.find((p) => p.path === "/pricing");
    expect(pricing?.title).toBe("Pricing Plans");
    expect(pricing?.headings).toContain("Starter Plan");

    const builder = res.pages.find((p) => p.path === "/features/builder");
    expect(builder?.title).toBe("Form Builder Feature");
  });

  it("handles missing sitemaps and falls back to homepage link discovery", async () => {
    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://acme.com/robots.txt" || url === "https://acme.com/sitemap.xml") {
        return new Response("Not found", { status: 404 });
      }

      if (url === "https://acme.com/" || url === "https://acme.com") {
        return new Response(
          `<html><head><title>Standalone Acme</title></head><body><h1>Standalone Acme</h1><a href="/features/surveys">Surveys</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://acme.com/features/surveys") {
        return new Response(
          `<html><head><title>Surveys</title></head><body><h1>Customer Surveys</h1></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const res = await crawlWebsiteInventory("https://acme.com", {
      fetchFn: mockFetch as unknown as typeof fetch,
      skipDnsCheck: true,
    });

    expect(res.status).toBe("success");
    expect(res.sitemapFound).toBe(false);
    expect(res.pagesCrawled).toBe(2);
  });

  it("returns failed status when homepage is unreachable", async () => {
    const mockFetch = async () => {
      return new Response("Server error", { status: 500 });
    };

    const res = await crawlWebsiteInventory("https://broken.com", {
      fetchFn: mockFetch as unknown as typeof fetch,
      skipDnsCheck: true,
    });

    expect(res.status).toBe("failed");
    expect(res.pagesCrawled).toBe(0);
    expect(res.error).toBeTruthy();
  });
});
