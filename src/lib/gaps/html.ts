/**
 * Pure, lightweight HTML, robots.txt, and sitemap XML parsing utilities.
 * Extracts title, meta description, canonical URL, headings, and internal links
 * without requiring heavy browser or scraping dependencies.
 */

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(raw: string): string {
  const stripped = raw.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped);
}

export type ExtractedMetadata = {
  title: string | null;
  description: string | null;
  canonicalUrl: string;
  h1: string | null;
  headings: string[];
  links: string[];
};

export function extractPageMetadata(html: string, pageUrl: string): ExtractedMetadata {
  let fallbackCanonical = pageUrl;
  try {
    const u = new URL(pageUrl);
    u.hash = "";
    fallbackCanonical = u.toString();
  } catch {
    // Keep raw pageUrl
  }

  // Remove scripts, styles, and comments
  const sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // 1. Title
  let title: string | null = null;
  const titleMatch = sanitized.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const decoded = cleanText(titleMatch[1]);
    if (decoded.length > 0) {
      title = decoded;
    }
  }

  // 2. Meta description
  let description: string | null = null;
  const descMatch =
    sanitized.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    sanitized.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
    sanitized.match(/<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  if (descMatch && descMatch[1]) {
    const decoded = cleanText(descMatch[1]);
    if (decoded.length > 0) {
      description = decoded;
    }
  }

  // 3. Canonical URL
  let canonicalUrl = fallbackCanonical;
  const canonicalMatch = sanitized.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i);
  if (canonicalMatch && canonicalMatch[1]) {
    try {
      const resolved = new URL(canonicalMatch[1], pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        resolved.hash = "";
        canonicalUrl = resolved.toString();
      }
    } catch {
      // Fallback stays
    }
  }

  // 4. H1
  let h1: string | null = null;
  const h1Match = sanitized.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    const decoded = cleanText(h1Match[1]);
    if (decoded.length > 0) {
      h1 = decoded;
    }
  }

  // 5. Headings (H2 and H3)
  const headings: string[] = [];
  const headingMatches = sanitized.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi);
  const seenHeadings = new Set<string>();
  for (const match of headingMatches) {
    if (match[1]) {
      const decoded = cleanText(match[1]);
      const lower = decoded.toLowerCase();
      if (decoded.length >= 3 && !seenHeadings.has(lower)) {
        seenHeadings.add(lower);
        headings.push(decoded);
      }
    }
  }

  // 6. Links (<a href="...">)
  const links: string[] = [];
  const seenLinks = new Set<string>();
  const linkMatches = sanitized.matchAll(/<a\s+[^>]*href=["']([^"'#\s]+)["']/gi);
  for (const match of linkMatches) {
    if (match[1]) {
      try {
        const resolved = new URL(match[1], pageUrl);
        if (resolved.protocol === "http:" || resolved.protocol === "https:") {
          resolved.hash = "";
          const linkStr = resolved.toString();
          if (!seenLinks.has(linkStr)) {
            seenLinks.add(linkStr);
            links.push(linkStr);
          }
        }
      } catch {
        // Ignore unparseable link
      }
    }
  }

  return {
    title,
    description,
    canonicalUrl,
    h1,
    headings,
    links,
  };
}

export type RobotsTxtRules = {
  sitemaps: string[];
  disallowedPaths: string[];
};

export function parseRobotsTxt(robotsTxt: string): RobotsTxtRules {
  const sitemaps: string[] = [];
  const disallowedPaths: string[] = [];

  const lines = robotsTxt.split(/\r?\n/);
  let inGenericUserAgent = false;

  for (const line of lines) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;

    const sitemapMatch = clean.match(/^sitemap:\s*(https?:\/\/[^\s]+)/i);
    if (sitemapMatch && sitemapMatch[1]) {
      sitemaps.push(sitemapMatch[1]);
      continue;
    }

    const uaMatch = clean.match(/^user-agent:\s*(.+)$/i);
    if (uaMatch) {
      const agent = uaMatch[1].trim();
      inGenericUserAgent = agent === "*" || agent.toLowerCase().includes("leystic") || agent.toLowerCase().includes("lurk");
      continue;
    }

    if (inGenericUserAgent) {
      const disallowMatch = clean.match(/^disallow:\s*([^\s]+)/i);
      if (disallowMatch && disallowMatch[1]) {
        const path = disallowMatch[1].trim();
        if (path && path !== "/") {
          disallowedPaths.push(path);
        }
      }
    }
  }

  return { sitemaps: [...new Set(sitemaps)], disallowedPaths: [...new Set(disallowedPaths)] };
}

const STATIC_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|map|pdf|zip|tar|gz|mp4|webm|avi|woff|woff2|ttf|eot)$/i;

export function parseSitemapXml(sitemapXml: string, host: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const matches = sitemapXml.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi);

  for (const match of matches) {
    if (match[1]) {
      try {
        const parsed = new URL(match[1]);
        if (parsed.hostname.toLowerCase() === host.toLowerCase()) {
          parsed.hash = "";
          const str = parsed.toString();
          if (!STATIC_EXTENSIONS.test(parsed.pathname) && !seen.has(str)) {
            seen.add(str);
            urls.push(str);
          }
        }
      } catch {
        // Ignore invalid URL in sitemap
      }
    }
  }

  return urls;
}
