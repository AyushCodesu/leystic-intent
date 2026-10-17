import { describe, expect, it } from "vitest";
import { isPrivateIp, safeFetch, SecurityError, validateSafeUrl } from "@/lib/gaps/security";

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
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
  });

  it("allows standard public IPv4 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("142.250.190.46")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
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
});

describe("safeFetch", () => {
  it("handles redirects safely and respects allowed host", async () => {
    const mockFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://acme.com/old-page") {
        return new Response(null, {
          status: 301,
          headers: { Location: "https://acme.com/new-page" },
        });
      }
      if (url === "https://acme.com/new-page") {
        return new Response("<html><head><title>New Page</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const res = await safeFetch("https://acme.com/old-page", {
      allowedHost: "acme.com",
      skipDnsCheck: true,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe(200);
    expect(res.url).toBe("https://acme.com/new-page");
    expect(res.text).toContain("New Page");
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
});
