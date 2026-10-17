import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  defaultNodeTransport,
  isPrivateIp,
  resolveSafeHost,
  safeFetch,
  SecurityError,
  validateSafeUrl,
} from "@/lib/gaps/security";
import type { DnsAddress, SafeHttpTransport } from "@/lib/gaps/security";

describe("SSRF and IP validation", () => {
  it("detects IPv4 loopback and private ranges", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.10.20.30")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.254.254.254")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("192.168.100.50")).toBe(true);
  });

  it("detects link-local, AWS/cloud metadata, and carrier-grade NAT", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("169.254.1.1")).toBe(true);
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("detects test nets, benchmarking, multicast, and reserved ranges", () => {
    expect(isPrivateIp("192.0.2.1")).toBe(true);
    expect(isPrivateIp("198.18.0.1")).toBe(true);
    expect(isPrivateIp("198.51.100.1")).toBe(true);
    expect(isPrivateIp("203.0.113.1")).toBe(true);
    expect(isPrivateIp("224.0.0.1")).toBe(true);
    expect(isPrivateIp("240.0.0.1")).toBe(true);
  });

  it("detects IPv6 loopback, unique local, link-local, and IPv4-mapped addresses", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("ff02::1")).toBe(true);
    expect(isPrivateIp("2001:db8::1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateIp("::127.0.0.1")).toBe(true);
    expect(isPrivateIp("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateIp("[127.0.0.1]")).toBe(true);
  });

  it("allows standard public IPv4 and IPv6 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("142.250.190.46")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("resolveSafeHost", () => {
  it("returns all resolved addresses when all are public", async () => {
    const mockResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];

    const addrs = await resolveSafeHost("example.com", { dnsResolver: mockResolver });
    expect(addrs).toHaveLength(2);
    expect(addrs[0].address).toBe("93.184.216.34");
    expect(addrs[1].address).toBe("2606:2800:220:1:248:1893:25c8:1946");
  });

  it("rejects host when DNS returns mixed public and private IPv4 answers", async () => {
    const mockResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];

    await expect(
      resolveSafeHost("mixed.example.com", { dnsResolver: mockResolver }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: 127.0.0.1");
  });

  it("rejects host when DNS returns mixed public and private IPv6 answers", async () => {
    const mockResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ];

    await expect(
      resolveSafeHost("mixed6.example.com", { dnsResolver: mockResolver }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: ::1");
  });

  it("rejects host when DNS returns cloud metadata address", async () => {
    const mockResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];

    await expect(
      resolveSafeHost("meta.example.com", { dnsResolver: mockResolver }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: 169.254.169.254");
  });

  it("rejects host when DNS returns IPv4-mapped private IPv6 addresses", async () => {
    const mockResolver = async () => [{ address: "::ffff:127.0.0.1", family: 6 }];

    await expect(
      resolveSafeHost("mapped.example.com", { dnsResolver: mockResolver }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: ::ffff:127.0.0.1");
  });

  it("rejects host when DNS lookup throws an error", async () => {
    const mockResolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };

    await expect(
      resolveSafeHost("nonexistent.example.com", { dnsResolver: mockResolver }),
    ).rejects.toThrow("DNS lookup failed for host: nonexistent.example.com");
  });

  it("rejects host when DNS lookup returns an empty array", async () => {
    const mockResolver = async () => [];

    await expect(
      resolveSafeHost("empty.example.com", { dnsResolver: mockResolver }),
    ).rejects.toThrow("DNS lookup returned no addresses for host: empty.example.com");
  });

  it("validates direct public IP literals without invoking DNS resolver", async () => {
    let resolverCalled = false;
    const mockResolver = async () => {
      resolverCalled = true;
      return [];
    };

    const addrs = await resolveSafeHost("93.184.216.34", { dnsResolver: mockResolver });
    expect(resolverCalled).toBe(false);
    expect(addrs[0].address).toBe("93.184.216.34");
  });

  it("rejects direct private IP literals immediately", async () => {
    await expect(resolveSafeHost("127.0.0.1")).rejects.toThrow(
      "Direct private IP destination blocked: 127.0.0.1",
    );
    await expect(resolveSafeHost("::1")).rejects.toThrow(
      "Direct private IP destination blocked: ::1",
    );
  });
});

describe("validateSafeUrl", () => {
  it("rejects non-http/https protocols", async () => {
    await expect(validateSafeUrl("ftp://example.com", { skipDnsCheck: true })).rejects.toThrow(
      SecurityError,
    );
    await expect(validateSafeUrl("file:///etc/passwd", { skipDnsCheck: true })).rejects.toThrow(
      SecurityError,
    );
    await expect(
      validateSafeUrl("javascript:alert(1)", { skipDnsCheck: true }),
    ).rejects.toThrow(SecurityError);
  });

  it("rejects localhost, local domains, and private destination hosts", async () => {
    await expect(validateSafeUrl("http://localhost:3000", { skipDnsCheck: true })).rejects.toThrow(
      SecurityError,
    );
    await expect(
      validateSafeUrl("https://app.localhost", { skipDnsCheck: true }),
    ).rejects.toThrow(SecurityError);
    await expect(
      validateSafeUrl("http://service.internal", { skipDnsCheck: true }),
    ).rejects.toThrow(SecurityError);
    await expect(validateSafeUrl("http://127.0.0.1:8080", { skipDnsCheck: true })).rejects.toThrow(
      SecurityError,
    );
    await expect(
      validateSafeUrl("http://169.254.169.254/latest/meta-data", { skipDnsCheck: true }),
    ).rejects.toThrow(SecurityError);
  });

  it("rejects IPv4-mapped IPv6 destination hosts", async () => {
    await expect(
      validateSafeUrl("http://[::ffff:127.0.0.1]/status", { skipDnsCheck: true }),
    ).rejects.toThrow(SecurityError);
    await expect(
      validateSafeUrl("http://[::ffff:169.254.169.254]/meta", { skipDnsCheck: true }),
    ).rejects.toThrow(SecurityError);
  });

  it("enforces allowedHost constraint", async () => {
    await expect(
      validateSafeUrl("https://evil.com/page", { allowedHost: "acme.com", skipDnsCheck: true }),
    ).rejects.toThrow("Host mismatch");

    const valid = await validateSafeUrl("https://acme.com/pricing", {
      allowedHost: "acme.com",
      skipDnsCheck: true,
    });
    expect(valid.hostname).toBe("acme.com");
  });

  it("validates through injected DNS resolver", async () => {
    const mockResolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const valid = await validateSafeUrl("https://valid.com/page", { dnsResolver: mockResolver });
    expect(valid.hostname).toBe("valid.com");

    const badResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ];
    await expect(
      validateSafeUrl("https://valid.com/page", { dnsResolver: badResolver }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: 192.168.1.1");
  });
});

describe("safeFetch", () => {
  it("pins outbound connection to validated address preventing DNS rebinding", async () => {
    // Simulates an attacker whose DNS resolver returns a public IP on initial check
    // but mutates to return a private IP on subsequent lookups.
    let lookupCount = 0;
    const mockDnsResolver = async (): Promise<DnsAddress[]> => {
      lookupCount++;
      if (lookupCount === 1) {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "127.0.0.1", family: 4 }];
    };

    let socketConnectedAddress = "";
    const mockTransport: SafeHttpTransport = async (req) => {
      // The transport receives the pinned address chosen during validation
      socketConnectedAddress = req.pinnedAddress.address;
      return {
        status: 200,
        headers: { get: () => "text/html" },
        body: new Response("<html><body>Safe Page</body></html>").body,
      };
    };

    const res = await safeFetch("https://rebind.attacker.com/page", {
      dnsResolver: mockDnsResolver,
      transport: mockTransport,
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Safe Page");
    // Verify the socket was pinned strictly to the validated public address
    expect(socketConnectedAddress).toBe("93.184.216.34");
    expect(socketConnectedAddress).not.toBe("127.0.0.1");
  });

  it("rejects request immediately if DNS resolver returns mixed public and private answers", async () => {
    const mockDnsResolver = async (): Promise<DnsAddress[]> => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];

    let transportCalled = false;
    const mockTransport: SafeHttpTransport = async () => {
      transportCalled = true;
      return {
        status: 200,
        headers: { get: () => null },
        body: null,
      };
    };

    await expect(
      safeFetch("https://mixed.example.com/test", {
        dnsResolver: mockDnsResolver,
        transport: mockTransport,
      }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: 10.0.0.1");

    // Transport must never even be invoked
    expect(transportCalled).toBe(false);
  });

  it("rejects request if DNS resolver fails or returns empty addresses", async () => {
    const failingResolver = async (): Promise<DnsAddress[]> => {
      throw new Error("ENOTFOUND");
    };

    await expect(
      safeFetch("https://fail.example.com", { dnsResolver: failingResolver }),
    ).rejects.toThrow("DNS lookup failed for host: fail.example.com");

    const emptyResolver = async (): Promise<DnsAddress[]> => [];
    await expect(
      safeFetch("https://empty.example.com", { dnsResolver: emptyResolver }),
    ).rejects.toThrow("DNS lookup returned no addresses for host: empty.example.com");
  });

  it("handles redirects safely with independent validation and connection pinning on every hop", async () => {
    const mockDnsResolver = async (host: string): Promise<DnsAddress[]> => {
      if (host === "acme.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "142.250.190.46", family: 4 }];
    };

    const connectedHosts: string[] = [];
    const mockTransport: SafeHttpTransport = async (req) => {
      connectedHosts.push(req.url.toString());
      if (req.url.pathname === "/old-page") {
        return {
          status: 301,
          headers: {
            get: (name: string) => (name.toLowerCase() === "location" ? "https://acme.com/new-page" : null),
          },
          body: null,
        };
      }
      if (req.url.pathname === "/new-page") {
        return {
          status: 200,
          headers: {
            get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
          },
          body: new Response("<html><head><title>New Page</title></head></html>").body,
        };
      }
      return { status: 404, headers: { get: () => null }, body: null };
    };

    const res = await safeFetch("https://acme.com/old-page", {
      allowedHost: "acme.com",
      dnsResolver: mockDnsResolver,
      transport: mockTransport,
    });

    expect(res.status).toBe(200);
    expect(res.url).toBe("https://acme.com/new-page");
    expect(res.text).toContain("New Page");
    expect(connectedHosts).toEqual([
      "https://acme.com/old-page",
      "https://acme.com/new-page",
    ]);
  });

  it("rejects redirect hop when redirected to a host resolving to a private IP", async () => {
    const mockDnsResolver = async (host: string): Promise<DnsAddress[]> => {
      if (host === "acme.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      if (host === "internal.acme.com") {
        return [{ address: "192.168.1.10", family: 4 }];
      }
      return [{ address: "127.0.0.1", family: 4 }];
    };

    const connectedUrls: string[] = [];
    const mockTransport: SafeHttpTransport = async (req) => {
      connectedUrls.push(req.url.toString());
      return {
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "location" ? "https://internal.acme.com/secret" : null,
        },
        body: null,
      };
    };

    await expect(
      safeFetch("https://acme.com/hop", {
        dnsResolver: mockDnsResolver,
        transport: mockTransport,
      }),
    ).rejects.toThrow("Destination resolves to private or restricted IP: 192.168.1.10");

    // The second hop must never be requested
    expect(connectedUrls).toEqual(["https://acme.com/hop"]);
  });

  it("rejects redirect to an external or forbidden host", async () => {
    const mockFetch = async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.com/evil" },
      });
    };

    await expect(
      safeFetch("https://acme.com/redirect", {
        allowedHost: "acme.com",
        skipDnsCheck: true,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(SecurityError);
  });

  it("rejects redirect to private IP", async () => {
    const mockFetch = async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest" },
      });
    };

    await expect(
      safeFetch("https://acme.com/meta", {
        skipDnsCheck: true,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(SecurityError);
  });

  it("enforces maximum redirect limit", async () => {
    let count = 0;
    const mockFetch = async () => {
      count++;
      return new Response(null, {
        status: 302,
        headers: { Location: `https://acme.com/loop-${count}` },
      });
    };

    await expect(
      safeFetch("https://acme.com/loop-0", {
        allowedHost: "acme.com",
        skipDnsCheck: true,
        maxRedirects: 2,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Redirect limit exceeded");
  });

  it("rejects responses that exceed max response bytes", async () => {
    const largeChunk = new Uint8Array(2000).fill(65);
    const mockFetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(largeChunk);
          controller.enqueue(largeChunk);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    await expect(
      safeFetch("https://acme.com/huge", {
        allowedHost: "acme.com",
        skipDnsCheck: true,
        maxBytes: 1500,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Response exceeded size limit");
  });

  it("defaultNodeTransport preserves SNI, Host header, and pins IP on live HTTP server", async () => {
    let receivedHostHeader = "";
    let receivedUserAgent = "";
    let receivedPath = "";

    const server = http.createServer((req, res) => {
      receivedHostHeader = req.headers.host ?? "";
      receivedUserAgent = req.headers["user-agent"] ?? "";
      receivedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("PONG_TEST");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const targetUrl = new URL(`http://custom-domain.test:${port}/live-ping?param=1`);
      const response = await defaultNodeTransport({
        url: targetUrl,
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        timeoutMs: 3000,
        headers: {
          Host: targetUrl.host,
          "User-Agent": "LeysticInspectionBot/1.0",
        },
      });

      expect(response.status).toBe(200);
      expect(receivedHostHeader).toBe(`custom-domain.test:${port}`);
      expect(receivedUserAgent).toBe("LeysticInspectionBot/1.0");
      expect(receivedPath).toBe("/live-ping?param=1");

      const chunks: Buffer[] = [];
      const nodeStream = response.body as NodeJS.ReadableStream;
      for await (const chunk of nodeStream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
      }
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      expect(bodyText).toBe("PONG_TEST");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
