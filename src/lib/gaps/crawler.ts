import {
  FETCH_TIMEOUT_MS,
  MAX_DISCOVERED_URLS,
  MAX_FETCHED_PAGES,
  MAX_SITEMAP_BYTES,
} from "./constants";
import { extractPageMetadata, parseRobotsTxt, parseSitemapXml } from "./html";
import { assertSourceAuthorized } from "@/lib/sourcePolicy";
import { safeFetch, validateSafeUrl } from "./security";
import type { DnsResolver, SafeHttpTransport } from "./security";
import type { InspectedPage, PageInventoryResult } from "./types";

const PRODUCT_PATH_PATTERNS = [
  /pric|plan/i,
  /feature|product|capability|solution|how-it-works/i,
  /integration|connect/i,
  /use-case|industry/i,
  /compare|alternative|vs/i,
  /doc|guide|faq|api/i,
];

function scorePathRelevance(path: string): number {
  for (let i = 0; i < PRODUCT_PATH_PATTERNS.length; i++) {
    if (PRODUCT_PATH_PATTERNS[i].test(path)) {
      return 10 - i;
    }
  }
  return 0;
}

export type CrawlOptions = {
  fetchFn?: typeof fetch;
  skipDnsCheck?: boolean;
  dnsResolver?: DnsResolver;
  transport?: SafeHttpTransport;
};

/**
 * Crawls a bounded inventory of pages for a configured product website.
 * Inspects robots.txt and sitemap if available, falls back to homepage and internal links,
 * respects host boundaries and size limits, and deduplicates canonical URLs.
 */
export async function crawlWebsiteInventory(
  rootUrl: string,
  options: CrawlOptions = {},
): Promise<PageInventoryResult> {
  assertSourceAuthorized({
    sourceId: "website_crawler",
    purpose: "customer_website_coverage",
    scope: "customer_domain_crawl",
  });

  const fetchFn = options.fetchFn ?? fetch;
  const skipDnsCheck = options.skipDnsCheck ?? false;
  const dnsResolver = options.dnsResolver;
  const transport = options.transport;

  let rootParsed: URL;
  try {
    rootParsed = await validateSafeUrl(rootUrl, { skipDnsCheck, dnsResolver });
  } catch (err) {
    return {
      status: "failed",
      pages: [],
      sitemapFound: false,
      pagesFound: 0,
      pagesCrawled: 0,
      error: err instanceof Error ? err.message : "Invalid website URL",
    };
  }

  const rootHost = rootParsed.hostname.toLowerCase();
  const origin = rootParsed.origin;

  let sitemaps: string[] = [];
  let disallowedPaths: string[] = [];

  // 1. Inspect robots.txt
  try {
    const robotsRes = await safeFetch(`${origin}/robots.txt`, {
      fetchFn,
      skipDnsCheck,
      dnsResolver,
      transport,
      allowedHost: rootHost,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (robotsRes.status === 200) {
      const parsedRobots = parseRobotsTxt(robotsRes.text);
      sitemaps = parsedRobots.sitemaps;
      disallowedPaths = parsedRobots.disallowedPaths;
    }
  } catch {
    // Ignore robots.txt failure; proceed safely
  }

  // 2. Discover URLs via sitemaps
  const sitemapTargets = [...new Set([...sitemaps, `${origin}/sitemap.xml`])];
  const discoveredQueue: string[] = [];
  const discoveredSet = new Set<string>();
  let sitemapFound = false;

  for (const sitemapUrl of sitemapTargets.slice(0, 2)) {
    try {
      const sitemapRes = await safeFetch(sitemapUrl, {
        fetchFn,
        skipDnsCheck,
        dnsResolver,
        transport,
        allowedHost: rootHost,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_SITEMAP_BYTES,
      });

      if (sitemapRes.status === 200 && sitemapRes.text.includes("<loc>")) {
        sitemapFound = true;
        const urls = parseSitemapXml(sitemapRes.text, rootHost);
        for (const u of urls) {
          if (!discoveredSet.has(u) && discoveredQueue.length < MAX_DISCOVERED_URLS) {
            discoveredSet.add(u);
            discoveredQueue.push(u);
          }
        }
      }
    } catch {
      // Continue to next sitemap or homepage
    }
  }

  // 3. Inspect homepage
  const inspectedPages: InspectedPage[] = [];
  const seenCanonicalUrls = new Set<string>();
  let homepageSuccess = false;

  const homepageUrl = `${origin}/`;
  try {
    const homeRes = await safeFetch(homepageUrl, {
      fetchFn,
      skipDnsCheck,
      dnsResolver,
      transport,
      allowedHost: rootHost,
      timeoutMs: FETCH_TIMEOUT_MS,
    });

    if (homeRes.status === 200) {
      homepageSuccess = true;
      const meta = extractPageMetadata(homeRes.text, homeRes.url);
      const canonical = meta.canonicalUrl || homeRes.url;
      seenCanonicalUrls.add(canonical.toLowerCase());

      inspectedPages.push({
        url: homeRes.url,
        canonicalUrl: canonical,
        title: meta.title,
        description: meta.description,
        h1: meta.h1,
        headings: meta.headings,
        path: "/",
        crawledAt: new Date(),
      });

      // Add discovered internal links from homepage to queue
      for (const link of meta.links) {
        try {
          const parsedLink = new URL(link);
          if (parsedLink.hostname.toLowerCase() === rootHost) {
            const cleanLink = parsedLink.toString();
            if (!discoveredSet.has(cleanLink) && discoveredQueue.length < MAX_DISCOVERED_URLS) {
              discoveredSet.add(cleanLink);
              discoveredQueue.push(cleanLink);
            }
          }
        } catch {
          // Ignore
        }
      }
    }
  } catch (err) {
    if (inspectedPages.length === 0) {
      return {
        status: "failed",
        pages: [],
        sitemapFound,
        pagesFound: discoveredQueue.length,
        pagesCrawled: 0,
        error: err instanceof Error ? err.message : "Failed to load homepage",
      };
    }
  }

  // 4. Crawl prioritized discovered pages up to MAX_FETCHED_PAGES
  const sortedQueue = [...discoveredQueue].sort((a, b) => {
    try {
      const pathA = new URL(a).pathname;
      const pathB = new URL(b).pathname;
      return scorePathRelevance(pathB) - scorePathRelevance(pathA);
    } catch {
      return 0;
    }
  });

  for (const pageUrl of sortedQueue) {
    if (inspectedPages.length >= MAX_FETCHED_PAGES) {
      break;
    }

    try {
      const parsed = new URL(pageUrl);
      const path = parsed.pathname;

      // Skip homepage if already crawled
      if (path === "/" || path === "") {
        continue;
      }

      // Check robots.txt disallow rules
      if (disallowedPaths.some((disallowed) => path.startsWith(disallowed))) {
        continue;
      }

      const res = await safeFetch(pageUrl, {
        fetchFn,
        skipDnsCheck,
        dnsResolver,
        transport,
        allowedHost: rootHost,
        timeoutMs: FETCH_TIMEOUT_MS,
      });

      if (res.status === 200) {
        const meta = extractPageMetadata(res.text, res.url);
        const canonical = meta.canonicalUrl || res.url;
        const canonicalLower = canonical.toLowerCase();

        if (!seenCanonicalUrls.has(canonicalLower)) {
          seenCanonicalUrls.add(canonicalLower);
          inspectedPages.push({
            url: res.url,
            canonicalUrl: canonical,
            title: meta.title,
            description: meta.description,
            h1: meta.h1,
            headings: meta.headings,
            path,
            crawledAt: new Date(),
          });
        }
      }
    } catch {
      // Individual page failure does not halt the overall inspection
    }
  }

  const finalStatus: "success" | "partial" | "failed" =
    inspectedPages.length > 0 ? (homepageSuccess ? "success" : "partial") : "failed";

  return {
    status: finalStatus,
    pages: inspectedPages,
    sitemapFound,
    pagesFound: Math.max(discoveredQueue.length, inspectedPages.length),
    pagesCrawled: inspectedPages.length,
    error: inspectedPages.length === 0 ? "No website pages could be fetched" : null,
  };
}
