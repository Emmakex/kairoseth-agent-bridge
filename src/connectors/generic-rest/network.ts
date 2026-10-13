import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { ConnectorConfigurationError } from "../sdk/errors.js";
import type {
  GenericRestHttpRuntime,
  GenericRestNetworkPolicy,
} from "./contracts.js";

const PRIVATE_BLOCKS = createPrivateBlockList();

export const defaultGenericRestHttpRuntime: GenericRestHttpRuntime = {
  async fetch(input, init) {
    return await fetch(input, init);
  },
  async resolveHost(hostname) {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((result) => result.address);
  },
};

export async function validateGenericRestBaseUrl(
  rawBaseUrl: unknown,
  policy: GenericRestNetworkPolicy = {},
  runtime: GenericRestHttpRuntime = defaultGenericRestHttpRuntime,
): Promise<URL> {
  if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) {
    throw new ConnectorConfigurationError("Generic REST baseUrl is required.");
  }

  let url: URL;

  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new ConnectorConfigurationError("Generic REST baseUrl is invalid.");
  }

  if (url.username || url.password) {
    throw new ConnectorConfigurationError(
      "Generic REST baseUrl must not contain embedded credentials.",
    );
  }

  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new ConnectorConfigurationError(
      "Generic REST baseUrl must use HTTPS unless HTTP is explicitly enabled.",
    );
  }

  if (url.search || url.hash) {
    throw new ConnectorConfigurationError(
      "Generic REST baseUrl must not contain query parameters or fragments.",
    );
  }

  if (policy.allowedOrigins && policy.allowedOrigins.length > 0) {
    const allowed = new Set(
      policy.allowedOrigins.map((origin) => normalizeAllowedOrigin(origin)),
    );

    if (!allowed.has(url.origin)) {
      throw new ConnectorConfigurationError(
        `Generic REST origin is not allowlisted: ${url.origin}`,
      );
    }
  }

  if (!policy.allowPrivateNetwork) {
    if (isObviouslyLocalHostname(url.hostname)) {
      throw new ConnectorConfigurationError(
        "Generic REST public-only policy blocks local hostnames.",
      );
    }

    const addresses = await resolveAddresses(url.hostname, runtime);

    if (addresses.length === 0) {
      throw new ConnectorConfigurationError(
        "Generic REST baseUrl hostname did not resolve to an address.",
      );
    }

    for (const address of addresses) {
      if (!isPublicAddress(address)) {
        throw new ConnectorConfigurationError(
          `Generic REST public-only policy blocks non-public address: ${address}`,
        );
      }
    }
  }

  return url;
}

export function buildGenericRestUrl(
  baseUrl: URL,
  path: string,
  query: Readonly<Record<string, readonly string[]>> = {},
): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new ConnectorConfigurationError(
      "Generic REST operation path must be a single-origin absolute path.",
    );
  }

  const prefix = baseUrl.pathname.endsWith("/")
    ? baseUrl.pathname.slice(0, -1)
    : baseUrl.pathname;
  const candidate = new URL(`${prefix}${path}`, baseUrl.origin);

  if (candidate.origin !== baseUrl.origin) {
    throw new ConnectorConfigurationError(
      "Generic REST operation attempted to change request origin.",
    );
  }

  for (const [name, values] of Object.entries(query)) {
    for (const value of values) {
      candidate.searchParams.append(name, value);
    }
  }

  return candidate;
}

function normalizeAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorConfigurationError(
      `Generic REST allowed origin is invalid: ${value}`,
    );
  }

  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConnectorConfigurationError(
      `Generic REST allowed origin must contain only scheme/host/port: ${value}`,
    );
  }

  return url.origin;
}

async function resolveAddresses(
  hostname: string,
  runtime: GenericRestHttpRuntime,
): Promise<readonly string[]> {
  if (isIP(hostname)) {
    return [hostname];
  }

  try {
    return await runtime.resolveHost(hostname);
  } catch (error) {
    throw new ConnectorConfigurationError(
      `Generic REST baseUrl hostname resolution failed: ${hostname}`,
      { cause: error },
    );
  }
}

function isObviouslyLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE_BLOCKS.check(address, "ipv4");
  if (family === 6) return !PRIVATE_BLOCKS.check(address, "ipv6");
  return false;
}

function createPrivateBlockList(): BlockList {
  const blockList = new BlockList();

  // IPv4 non-public/special-use ranges relevant to SSRF defense.
  blockList.addSubnet("0.0.0.0", 8, "ipv4");
  blockList.addSubnet("10.0.0.0", 8, "ipv4");
  blockList.addSubnet("100.64.0.0", 10, "ipv4");
  blockList.addSubnet("127.0.0.0", 8, "ipv4");
  blockList.addSubnet("169.254.0.0", 16, "ipv4");
  blockList.addSubnet("172.16.0.0", 12, "ipv4");
  blockList.addSubnet("192.0.0.0", 24, "ipv4");
  blockList.addSubnet("192.0.2.0", 24, "ipv4");
  blockList.addSubnet("192.168.0.0", 16, "ipv4");
  blockList.addSubnet("198.18.0.0", 15, "ipv4");
  blockList.addSubnet("198.51.100.0", 24, "ipv4");
  blockList.addSubnet("203.0.113.0", 24, "ipv4");
  blockList.addSubnet("224.0.0.0", 4, "ipv4");
  blockList.addSubnet("240.0.0.0", 4, "ipv4");

  // IPv6 unspecified, loopback, ULA, link-local, documentation and multicast.
  blockList.addAddress("::", "ipv6");
  blockList.addAddress("::1", "ipv6");
  blockList.addSubnet("fc00::", 7, "ipv6");
  blockList.addSubnet("fe80::", 10, "ipv6");
  blockList.addSubnet("2001:db8::", 32, "ipv6");
  blockList.addSubnet("ff00::", 8, "ipv6");

  return blockList;
}
