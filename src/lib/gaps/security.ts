import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  FETCH_TIMEOUT_MS,
  INSPECTION_USER_AGENT,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from "./constants";

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/**
 * Checks whether an IP address string is a private, loopback, link-local,
 * cloud metadata, or reserved address.
 */
export function isPrivateIp(ip: string): boolean {
  const cleanIp = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");

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
  // Multicast ff00::/8
  if (cleanIp.startsWith("ff")) {
    return true;
  }
  // Documentation 2001:db8::/32
  if (cleanIp.startsWith("2001:db8") || cleanIp.startsWith("2001:0db8")) {
    return true;
  }
  // Benchmarking 2001:2::/48
  if (cleanIp.startsWith("2001:2:") || cleanIp.startsWith("2001:0002:")) {
    return true;
  }
  // Discard prefix 100::/64
  if (cleanIp.startsWith("100::")) {
    return true;
  }

  // Embedded IPv4 in IPv6 (e.g. ::ffff:127.0.0.1, ::127.0.0.1, ::ffff:0:127.0.0.1)
  const embeddedIpv4 = cleanIp.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embeddedIpv4) {
    return isPrivateIp(embeddedIpv4[1]);
  }

  // Hex format IPv4-mapped IPv6 (e.g. ::ffff:7f00:1)
  if (cleanIp.startsWith("::ffff:")) {
    const hex = cleanIp.slice(7);
    const parts = hex.split(":");
    if (parts.length === 2 && /^[0-9a-f]{1,4}$/.test(parts[0]) && /^[0-9a-f]{1,4}$/.test(parts[1])) {
      const p1 = parseInt(parts[0], 16);
      const p2 = parseInt(parts[1], 16);
      const o1 = (p1 >> 8) & 0xff;
      const o2 = p1 & 0xff;
      const o3 = (p2 >> 8) & 0xff;
      const o4 = p2 & 0xff;
      return isPrivateIp(`${o1}.${o2}.${o3}.${o4}`);
    }
  }

  return false;
}

export type DnsAddress = {
  address: string;
  family: number;
};

export type DnsResolver = (hostname: string) => Promise<DnsAddress[]>;

export const defaultDnsResolver: DnsResolver = async (hostname: string): Promise<DnsAddress[]> => {
  const answers = await lookup(hostname, { all: true });
  return answers.map((a) => ({ address: a.address, family: a.family }));
};

export type ResolveSafeHostOptions = {
  dnsResolver?: DnsResolver;
  skipDnsCheck?: boolean;
};

/**
 * Resolves all IPv4 and IPv6 addresses for a hostname and validates each address.
 * Rejects with SecurityError if any returned address is private, loopback, or restricted.
 */
export async function resolveSafeHost(
  hostname: string,
  options: ResolveSafeHostOptions = {},
): Promise<DnsAddress[]> {
  const cleanHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");

  const ipFamily = isIP(cleanHost);
  if (ipFamily !== 0) {
    if (isPrivateIp(cleanHost)) {
      throw new SecurityError(`Direct private IP destination blocked: ${hostname}`);
    }
    return [{ address: cleanHost, family: ipFamily }];
  }

  if (options.skipDnsCheck) {
    return [{ address: "93.184.216.34", family: 4 }];
  }

  const resolver = options.dnsResolver ?? defaultDnsResolver;
  let addresses: DnsAddress[];
  try {
    addresses = await resolver(cleanHost);
  } catch (err) {
    if (err instanceof SecurityError) {
      throw err;
    }
    throw new SecurityError(`DNS lookup failed for host: ${hostname}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SecurityError(`DNS lookup returned no addresses for host: ${hostname}`);
  }

  for (const entry of addresses) {
    if (!entry.address || isPrivateIp(entry.address)) {
      throw new SecurityError(`Destination resolves to private or restricted IP: ${entry.address}`);
    }
  }

  return addresses;
}

export type SafeUrlOptions = {
  allowedHost?: string;
  skipDnsCheck?: boolean;
  dnsResolver?: DnsResolver;
};

export type ValidatedSafeUrl = {
  url: URL;
  pinnedAddresses: DnsAddress[];
};

/**
 * Validates a target URL against SSRF and network access policies,
 * resolving and verifying all DNS answers against private and restricted ranges.
 */
export async function validateSafeUrlWithDns(
  rawUrl: string,
  options: SafeUrlOptions = {},
): Promise<ValidatedSafeUrl> {
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

  const pinnedAddresses = await resolveSafeHost(hostname, {
    dnsResolver: options.dnsResolver,
    skipDnsCheck: options.skipDnsCheck,
  });

  return { url: parsed, pinnedAddresses };
}

/**
 * Validates a target URL against SSRF and network access policies.
 * Accepts only http: and https: protocols and blocks access to internal hosts.
 */
export async function validateSafeUrl(rawUrl: string, options: SafeUrlOptions = {}): Promise<URL> {
  const { url } = await validateSafeUrlWithDns(rawUrl, options);
  return url;
}

export type TransportRequest = {
  url: URL;
  pinnedAddress: DnsAddress;
  timeoutMs: number;
  headers: Record<string, string>;
};

export type TransportResponse = {
  status: number;
  headers: {
    get(name: string): string | null;
  };
  body: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | ReadableStream<Uint8Array> | null;
};

export type SafeHttpTransport = (req: TransportRequest) => Promise<TransportResponse>;

/**
 * Default outbound HTTP/HTTPS transport that pins socket connection directly
 * to the pre-validated IP address without re-resolving DNS, while preserving
 * TLS SNI, certificate validation, and HTTP Host header behavior.
 */
export const defaultNodeTransport: SafeHttpTransport = async (
  req: TransportRequest,
): Promise<TransportResponse> => {
  const { url, pinnedAddress, timeoutMs, headers } = req;
  const isHttps = url.protocol === "https:";
  const defaultPort = isHttps ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const reqModule = isHttps ? https : http;

  return new Promise<TransportResponse>((resolve, reject) => {
    let settled = false;

    const clientReq = reqModule.request({
      host: url.hostname,
      port,
      path: url.pathname + url.search,
      method: "GET",
      headers,
      servername: url.hostname,
      agent: false,
      lookup: (_hostname, opts, cb) => {
        if (typeof opts === "function") {
          cb = opts;
          opts = {};
        }
        if (opts && (opts as { all?: boolean }).all) {
          cb(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }] as unknown as DnsAddress[]);
        } else {
          cb(null, pinnedAddress.address, pinnedAddress.family);
        }
      },
    });

    clientReq.setTimeout(timeoutMs, () => {
      if (!settled) {
        settled = true;
        clientReq.destroy(new SecurityError(`Request timed out after ${timeoutMs}ms`));
        reject(new SecurityError(`Request timed out after ${timeoutMs}ms`));
      }
    });

    clientReq.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    clientReq.on("response", (res) => {
      if (!settled) {
        settled = true;
        resolve({
          status: res.statusCode ?? 200,
          headers: {
            get(name: string): string | null {
              const val = res.headers[name.toLowerCase()];
              if (Array.isArray(val)) return val.join(", ");
              return val ?? null;
            },
          },
          body: res,
        });
      }
    });

    clientReq.end();
  });
};

async function readBodyWithLimit(
  body: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  if ("getReader" in body && typeof body.getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // Ignore cancel error
            }
            throw new SecurityError(`Response exceeded size limit of ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else if (Symbol.asyncIterator in body) {
    const stream = body as NodeJS.ReadableStream & AsyncIterable<Uint8Array | string>;
    for await (const chunk of stream) {
      const bufferChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      receivedBytes += bufferChunk.length;
      if (receivedBytes > maxBytes) {
        if ("destroy" in stream && typeof stream.destroy === "function") {
          stream.destroy();
        }
        throw new SecurityError(`Response exceeded size limit of ${maxBytes} bytes`);
      }
      chunks.push(bufferChunk);
    }
  }

  const totalBuffer = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    totalBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(totalBuffer);
}

export type SafeFetchOptions = {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  allowedHost?: string;
  skipDnsCheck?: boolean;
  dnsResolver?: DnsResolver;
  transport?: SafeHttpTransport;
  fetchFn?: typeof fetch;
};

export type SafeFetchResult = {
  url: string;
  status: number;
  text: string;
  contentType: string;
};

/**
 * Executes a bounded direct HTTP request with SSRF validation, DNS answer screening,
 * connection IP pinning, and redirect re-evaluation.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const deadline = Date.now() + timeoutMs;

  let transport: SafeHttpTransport;
  if (options.transport) {
    transport = options.transport;
  } else if (options.fetchFn) {
    const customFetch = options.fetchFn;
    transport = async (req) => {
      const res = await customFetch(req.url.toString(), {
        method: "GET",
        headers: req.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      return {
        status: res.status,
        headers: {
          get: (name: string) => res.headers.get(name),
        },
        body: res.body,
      };
    };
  } else {
    transport = defaultNodeTransport;
  }

  let currentUrl = rawUrl;
  let remainingRedirects = maxRedirects;

  while (true) {
    const remainingTimeoutMs = Math.max(1, deadline - Date.now());
    if (deadline - Date.now() <= 0) {
      throw new SecurityError(`Request timed out after ${timeoutMs}ms`);
    }

    const { url: validatedUrl, pinnedAddresses } = await validateSafeUrlWithDns(currentUrl, {
      allowedHost: options.allowedHost,
      skipDnsCheck: options.skipDnsCheck,
      dnsResolver: options.dnsResolver,
    });

    const pinnedAddress = pinnedAddresses[0];

    const headers: Record<string, string> = {
      "User-Agent": INSPECTION_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Host: validatedUrl.host,
    };

    let response: TransportResponse;
    try {
      response = await transport({
        url: validatedUrl,
        pinnedAddress,
        timeoutMs: remainingTimeoutMs,
        headers,
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        throw err;
      }
      throw new SecurityError(
        `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      if (response.body) {
        try {
          if ("destroy" in response.body && typeof response.body.destroy === "function") {
            response.body.destroy();
          } else if ("cancel" in response.body && typeof response.body.cancel === "function") {
            await response.body.cancel();
          }
        } catch {
          // Ignore cleanup error
        }
      }

      if (remainingRedirects <= 0) {
        throw new SecurityError("Redirect limit exceeded");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new SecurityError(`Redirect status ${response.status} missing Location header`);
      }

      const nextUrl = new URL(location, validatedUrl);
      currentUrl = nextUrl.toString();
      remainingRedirects -= 1;
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "text/html";
    const text = await readBodyWithLimit(response.body, maxBytes);

    return {
      url: currentUrl,
      status: response.status,
      text,
      contentType,
    };
  }
}
