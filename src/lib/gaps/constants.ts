/**
 * Centralized constants and bounds for Demand-to-Page Gap Finder V1.
 * Prevents runaway crawling, unbounded DB loads, and scattered magic numbers.
 */

/** Maximum URLs discovered in sitemaps and links before stopping queue growth */
export const MAX_DISCOVERED_URLS = 50;

/** Maximum pages safely fetched per manual website inspection */
export const MAX_FETCHED_PAGES = 25;

/** Maximum redirects followed per safe fetch request */
export const MAX_REDIRECTS = 3;

/** Per-page request timeout in milliseconds */
export const FETCH_TIMEOUT_MS = 6000;

/** Maximum response body size permitted per page (512 KB) */
export const MAX_RESPONSE_BYTES = 512 * 1024;

/** Maximum sitemap XML response size permitted (1 MB) */
export const MAX_SITEMAP_BYTES = 1024 * 1024;

/** Bounded sample of recent leads examined for demand analysis */
export const LEAD_SAMPLE_LIMIT = 250;

/** Minimum distinct buyer threads for a gap to reach high priority without commercial progress */
export const MIN_SUPPORTING_THREADS_FOR_HIGH_PRIORITY = 2;

/** Score threshold for strong page match */
export const HIGH_MATCH_SCORE_THRESHOLD = 6;

/** Score threshold for possible page match */
export const POSSIBLE_MATCH_SCORE_THRESHOLD = 2;

/** Standard user agent for Leystic safe website inspection */
export const INSPECTION_USER_AGENT = "LeysticBot/1.0 (+https://leystic.com; website coverage inspection)";
