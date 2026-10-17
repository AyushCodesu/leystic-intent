import { lookup } from "node:dns/promises";
import { FETCH_TIMEOUT_MS, INSPECTION_USER_AGENT, MAX_REDIRECTS, MAX_RESPONSE_BYTES } from "./constants";

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/**
 * Checks whether an IP address string is a private, loopback, link-local,
 * or cloud metadata address.
 */
export function isPrivateIp(ip: string): boolean {
  const cleanIp = ip.trim().toLowerCase();

  // IPv4 check
  const ipv4Match = cleanIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const o1 = Number(ipv4Match[1]);
    const o2 = Number(ipv4Match[2]);
    const o3 = Number(ipv4Match[3]);
    const o4 = Number(ipv4Match[4]);

    if ([o1, o2, o3, o4].some((o) => o < 0 || o > 255)) {
      return true;
    }
    // 0.0.0.0/8 (Current network)
    if (o1 === 0) return true;
    // 10.0.0.0/8 (Private)
    if (o1 === 10) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata)
    if (o1 === 169 && o2 === 254) return true;
    // 172.16.0.0/12 (Private)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    // 192.0.0.0/24 and 192.0.2.0/24 (Test nets)
    if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return true;
    // 192.168.0.0/16 (Private)
    if (o1 === 192 && o2 === 168) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return true;
    // 198.51.100.0/24 (Test net)
    if (o1 === 198 && o2 === 51 && o3 === 100) return true;
    // 203.0.113.0/24 (Test net)
    if (o1 === 203 && o2 === 0 && o3 === 113) return true;
    // 224.0.0.0/4 (Multicast) and 240.0.0.0/4 (Reserved)
    if (o1 >= 224) return true;

    return false;
  }

  // IPv6 checks
  if (
    cleanIp === "::1" ||
    cleanIp === "::" ||
    cleanIp === "0:0:0:0:0:0:0:1" ||
    cleanIp === "0000:0000:0000:0000:0000:0000:0000:0001"
  ) {
    return true;
  }
  // Unique local fc00::/7 (fc or fd)
  if (cleanIp.startsWith("fc") || cleanIp.startsWith("fd")) {
    return true;
  }
  // Link-local fe80::/10 (fe8, fe9, fea, feb)
  if (/^fe[89ab]/.test(cleanIp)) {
    return true;
  }
  // IPv4-mapped IPv6
  if (cleanIp.startsWith("::ffff:")) {
    const mapped = cleanIp.slice(7);
    return isPrivateIp(mapped);
  }

  return false;
}

export type SafeUrlOptions = {
  allowedHost?: string;
  skipDnsCheck?: boolean;
};

/**
 * Validates a target URL against SSRF and network access policies.
 * Accepts only http: and https: protocols and blocks access to internal hosts.
 */
export async function validateSafeUrl(rawUrl: string, options: SafeUrlOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SecurityError(`Malformed URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SecurityError(`Disallowed protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new SecurityError("Empty hostname");
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname === "0.0.0.0"
  ) {
    throw new SecurityError(`Disallowed internal hostname: ${hostname}`);
  }

  if (options.allowedHost && hostname !== options.allowedHost.toLowerCase()) {
    throw new SecurityError(`Host mismatch: requested ${hostname}, allowed ${options.allowedHost}`);
  }

  if (isPrivateIp(hostname)) {
    throw new SecurityError(`Direct private IP destination blocked: ${hostname}`);
  }

  if (!options.skipDnsCheck) {
    try {
      const resolved = await lookup(hostname);
      if (isPrivateIp(resolved.address)) {
        throw new SecurityError(`Destination resolves to private IP: ${resolved.address}`);
      }
    } catch (err) {
      if (err instanceof SecurityError) {
        throw err;
      }
      throw new SecurityError(`DNS lookup failed for host: ${hostname}`);
    }
  }

  return parsed;
}

export type SafeFetchOptions = {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  allowedHost?: string;
  skipDnsCheck?: boolean;
  fetchFn?: typeof fetch;
};

export type SafeFetchResult = {
  url: string;
  status: number;
  text: string;
  contentType: string;
};

/**
 * Executes a bounded direct HTTP request with SSRF validation on every redirect hop,
 * strict response size capping, and timeout protection.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const fetchFn = options.fetchFn ?? fetch;

  let currentUrl = rawUrl;
  let remainingRedirects = maxRedirects;

  while (true) {
    const validated = await validateSafeUrl(currentUrl, {
      allowedHost: options.allowedHost,
      skipDnsCheck: options.skipDnsCheck,
    });

    const response = await fetchFn(validated.toString(), {
      method: "GET",
      headers: {
        "User-Agent": INSPECTION_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Handle redirects manually to enforce SSRF validation at each step
    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      if (remainingRedirects <= 0) {
        throw new SecurityError("Redirect limit exceeded");
      }
      const location = response.headers.get("Location");
      if (!location) {
        throw new SecurityError(`Redirect status ${response.status} missing Location header`);
      }

      const nextUrl = new URL(location, validated);
      currentUrl = nextUrl.toString();
      remainingRedirects -= 1;
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "text/html";

    // Read response with strict byte count limit
    if (!response.body) {
      return { url: currentUrl, status: response.status, text: "", contentType };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedBytes += value.length;
        if (receivedBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          throw new SecurityError(`Response exceeded size limit of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }

    const totalBuffer = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      totalBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(totalBuffer);

    return {
      url: currentUrl,
      status: response.status,
      text,
      contentType,
    };
  }
}
