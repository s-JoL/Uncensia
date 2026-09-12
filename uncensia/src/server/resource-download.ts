import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { MAX_UPLOAD_BYTES } from "./env.ts";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(network, prefix, "ipv6");

export function checkPublicAddress(address: string) {
  const version = isIP(address);
  if (!version || blocked.check(address, version === 6 ? "ipv6" : "ipv4")) throw new Error("Resource URL must resolve to a public Internet address");
  // Transition mechanisms can tunnel to a non-public IPv4 destination.
  if (version === 6 && !address.toLowerCase().startsWith("::ffff:") && !/^[23][0-9a-f]{3}:/.test(address.toLowerCase())) throw new Error("Resource URL must resolve to a public Internet address");
  if (/^(2002:|2001:0:)/i.test(address)) throw new Error("Resource URL must resolve to a public Internet address");
}

/** DNS is checked and pinned to the request, including every redirect. No cookies or credentials. */
export async function downloadResource(input: string, signal?: AbortSignal, dnsUrl?: string) {
  const cancellation = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]);
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    cancellation.throwIfAborted();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) URL without embedded credentials");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: Array<{ address: string; family: number }>;
    if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
    else if (dnsUrl) {
      const resolver = new URL(dnsUrl);
      if (resolver.protocol !== "https:" || resolver.username || resolver.password) throw new Error("Download DNS requires an HTTPS endpoint without credentials");
      resolver.searchParams.set("name", hostname); resolver.searchParams.set("type", "A");
      const reply = await fetch(resolver, { headers: { accept: "application/dns-json" }, signal: cancellation, redirect: "error" });
      if (!reply.ok) throw new Error(`Download DNS failed: HTTP ${reply.status}`);
      const data = await reply.json() as { Status?: number; Answer?: Array<{ type: number; data: string }> };
      if (data.Status) throw new Error(`Download DNS failed: status ${data.Status}`);
      addresses = (data.Answer ?? []).filter(item => item.type === 1 && isIP(item.data) === 4).map(item => ({ address: item.data, family: 4 }));
    } else addresses = await lookup(hostname, { all: true });
    if (!addresses.length) throw new Error("Resource host has no address");
    addresses.forEach(({ address }) => checkPublicAddress(address));
    const chosen = addresses[0]!;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(url, {
        signal: cancellation, family: chosen.family,
        lookup: (_host, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
        headers: { "user-agent": "Uncensia/1.0 resource reader", accept: "*/*", "accept-encoding": "identity" },
      }, resolve);
      request.on("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy();
      if (!response.headers.location || redirects === 5) throw new Error("Resource redirect limit reached or missing Location");
      url = new URL(response.headers.location, url);
      continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`Resource download failed: HTTP ${response.statusCode}`); }
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); throw new Error("Server ignored the uncompressed download request; compressed responses are unsupported"); }
    if (Number(response.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) { response.destroy(); throw new Error("Resource exceeds maximum file size"); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > MAX_UPLOAD_BYTES) { response.destroy(); throw new Error("Resource exceeds maximum file size"); }
      chunks.push(bytes);
    }
    if (!size) throw new Error("Resource is empty");
    const contentType = String(response.headers["content-type"] ?? "application/octet-stream");
    return { bytes: Buffer.concat(chunks), url: url.href, contentType, mime: contentType.split(";")[0]!.trim().toLowerCase() };
  }
  throw new Error("Resource redirect limit reached");
}
