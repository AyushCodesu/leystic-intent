import { describe, expect, it } from "vitest";
import { extractPageMetadata, parseRobotsTxt, parseSitemapXml } from "@/lib/gaps/html";

describe("extractPageMetadata", () => {
  it("extracts title, meta description, canonical, h1, headings, and internal links", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Acme &amp; Co | Form Builder for SaaS</title>
          <meta name="description" content="Build &quot;embeddable&quot; forms in minutes." />
          <link rel="canonical" href="https://acme.com/product" />
          <script>console.log("ignore me");</script>
          <style>.hide { display: none; }</style>
        </head>
        <body>
          <!-- banner -->
          <h1>Modern No-Code Form Builder</h1>
          <h2>Drag and drop survey creator</h2>
          <h3>Automated CRM Sync</h3>
          <h2>Integrations with Slack &amp; Zapier</h2>
          <p>Read our <a href="/pricing">Pricing plans</a> or see <a href="/features/surveys">Surveys</a>.</p>
          <a href="https://acme.com/docs">Documentation</a>
          <a href="https://other.com/outbound">External site</a>
        </body>
      </html>
    `;

    const meta = extractPageMetadata(html, "https://acme.com/product");

    expect(meta.title).toBe("Acme & Co | Form Builder for SaaS");
    expect(meta.description).toBe('Build "embeddable" forms in minutes.');
    expect(meta.canonicalUrl).toBe("https://acme.com/product");
    expect(meta.h1).toBe("Modern No-Code Form Builder");
    expect(meta.headings).toEqual([
      "Drag and drop survey creator",
      "Automated CRM Sync",
      "Integrations with Slack & Zapier",
    ]);
    expect(meta.links).toContain("https://acme.com/pricing");
    expect(meta.links).toContain("https://acme.com/features/surveys");
    expect(meta.links).toContain("https://acme.com/docs");
    expect(meta.links).toContain("https://other.com/outbound");
  });

  it("handles empty or sparse HTML gracefully", () => {
    const meta = extractPageMetadata("<html><body>Just text</body></html>", "https://acme.com/");
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.canonicalUrl).toBe("https://acme.com/");
    expect(meta.h1).toBeNull();
    expect(meta.headings).toEqual([]);
    expect(meta.links).toEqual([]);
  });
});

describe("parseRobotsTxt", () => {
  it("extracts sitemaps and disallow rules for all bots", () => {
    const robots = `
      # Robots file
      User-agent: Googlebot
      Disallow: /google-only/

      User-agent: *
      Disallow: /admin/
      Disallow: /api/
      Disallow: /private/secret.html

      Sitemap: https://acme.com/sitemap.xml
      Sitemap: https://acme.com/sitemap-posts.xml
    `;

    const parsed = parseRobotsTxt(robots);

    expect(parsed.sitemaps).toEqual([
      "https://acme.com/sitemap.xml",
      "https://acme.com/sitemap-posts.xml",
    ]);
    expect(parsed.disallowedPaths).toEqual([
      "/admin/",
      "/api/",
      "/private/secret.html",
    ]);
  });
});

describe("parseSitemapXml", () => {
  it("extracts loc URLs matching host and ignores static assets", () => {
    const xml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://acme.com/</loc></url>
        <url><loc>https://acme.com/pricing</loc></url>
        <url><loc>https://acme.com/features/forms</loc></url>
        <url><loc>https://acme.com/logo.png</loc></url>
        <url><loc>https://acme.com/manual.pdf</loc></url>
        <url><loc>https://other.com/blog</loc></url>
      </urlset>
    `;

    const urls = parseSitemapXml(xml, "acme.com");

    expect(urls).toEqual([
      "https://acme.com/",
      "https://acme.com/pricing",
      "https://acme.com/features/forms",
    ]);
  });
});
