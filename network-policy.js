"use strict";

const net = require("node:net");
const dns = require("node:dns/promises");

function matchesCidr(bytes, network, prefix) {
  const whole = Math.floor(prefix / 8);
  const remainder = prefix % 8;
  for (let i = 0; i < whole; i += 1) if (bytes[i] !== (network[i] || 0)) return false;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === ((network[whole] || 0) & mask);
}

function ipv4Bytes(address) { return address.split(".").map(Number); }

function parseIPv6(address) {
  if (address.includes("%")) return null;
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const v4 = ipv4Bytes(source.slice(lastColon + 1));
    source = `${source.slice(0, lastColon)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.flatMap((part) => { const value = parseInt(part, 16); return [value >> 8, value & 0xff]; });
}

function isPublicIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const blocked = [
      [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12],
      [[192, 0, 0], 24], [[192, 0, 2], 24], [[192, 88, 99], 24], [[192, 168], 16],
      [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4]
    ];
    return !blocked.some(([network, prefix]) => matchesCidr(ipv4Bytes(address), network, prefix));
  }
  if (version === 6) {
    const b = parseIPv6(address);
    // Reject mapped and transition addresses instead of reinterpreting them.
    if (!b || (b[0] & 0xe0) !== 0x20) return false;
    const blocked = [
      [[0x20, 0x01, 0, 0], 23], [[0x20, 0x01, 0x0d, 0xb8], 32],
      [[0x20, 0x02], 16], [[0x3f, 0xff], 20]
    ];
    return !blocked.some(([network, prefix]) => matchesCidr(b, network, prefix));
  }
  return false;
}

function publicWebUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Only public HTTP/HTTPS URLs without credentials are allowed");
  }
  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) throw new Error("Non-web port rejected");
  return url;
}

async function resolvePublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  let timer;
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([
    dns.lookup(host, { all: true, verbatim: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 5000); timer.unref(); })
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("Non-public destination rejected");
  }
  // Connect to this literal address; never resolve the hostname a second time.
  return addresses.find(({ family }) => family === 4) || addresses[0];
}

function sameAddress(a, b) {
  if (net.isIP(b) === 6 && b.toLowerCase().startsWith("::ffff:")) b = b.slice(7);
  if (net.isIP(a) === 4) return a === b;
  const left = parseIPv6(a);
  const right = parseIPv6(b);
  return Boolean(left && right && left.every((byte, i) => byte === right[i]));
}

module.exports = { isPublicIp, publicWebUrl, resolvePublicHost, sameAddress };
