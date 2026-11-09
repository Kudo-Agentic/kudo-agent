#!/usr/bin/env node
// Fails when a skill, prompt or package names a contract address that is not
// the current mainnet deployment in packages/sdk/src/networks.ts, or names a
// legacy Kudo contract at all. Skills are run verbatim by agents against
// mainnet, so a stale address there moves real money to the wrong place.
//   node scripts/check-skill-addresses.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const networks = readFileSync(join(ROOT, "packages/sdk/src/networks.ts"), "utf8");
const field = (name) => {
  const m = networks.match(new RegExp(`${name}: "(0x[0-9a-fA-F]{40})"`));
  if (!m) throw new Error(`networks.ts has no ${name} address`);
  return m[1];
};
const CURRENT = {
  kudo: field("kudo"),
  usdg: field("usdg"),
  identityRegistry: field("identityRegistry"),
  reputationRegistry: field("reputationRegistry"),
};
const LEGACY = {
  "0xc269c6176f3418a84fcda5911723b0d358971351": "the legacy mainnet Kudo contract",
  "0x7021279517a7b301b8d10ed9c3b9f73c101146f1": "the old testnet Kudo contract",
};
// Addresses that are fine to mention but are not contracts we deploy.
const OTHER_OK = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xca11bde05977b3631167028862be2a173976ca11", // multicall3
]);
const known = new Set(Object.values(CURRENT).map((a) => a.toLowerCase()));

const SCAN = ["skills", "kudo-agent/.claude/skills", "kudo-agent/prompts", "kudo-agent/agents", "packages"];
const SKIP = /(^|\/)(node_modules|dist|test)(\/|$)|\.map$|package-lock\.json$/;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(relative(ROOT, p))) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(md|txt|ts|mjs|json|sh)$/.test(name)) files.push(p);
  }
};
for (const d of SCAN) walk(join(ROOT, d));

const problems = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [addr] of line.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
      const lower = addr.toLowerCase();
      const where = `${relative(ROOT, file)}:${i + 1}`;
      // A legacy address may appear only where the text says it is not supported.
      const near = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
      if (LEGACY[lower] && /not supported/i.test(near)) continue;
      if (LEGACY[lower]) problems.push(`${where}: ${addr} is ${LEGACY[lower]}; use ${CURRENT.kudo}`);
      else if (known.has(lower)) {
        const name = Object.entries(CURRENT).find(([, a]) => a.toLowerCase() === lower)[0];
        if (addr !== CURRENT[name] && addr !== lower) problems.push(`${where}: ${addr} is ${name} with a wrong checksum; write ${CURRENT[name]}`);
      }
    }
  });
  // Known contract roles named next to a different address, e.g. "Kudo | 0x…".
  lines.forEach((line, i) => {
    const m = line.match(/\b(Kudo|KUDO|USDG|Identity Registry|IDENTITY_REGISTRY)\b[^0-9a-zA-Z]{1,12}(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/);
    if (!m) return;
    const want = /USDG/.test(m[1]) ? CURRENT.usdg : /dentity|IDENTITY/.test(m[1]) ? CURRENT.identityRegistry : CURRENT.kudo;
    const got = m[2].toLowerCase();
    if (got !== want.toLowerCase() && !LEGACY[got] && !OTHER_OK.has(got)) {
      problems.push(`${relative(ROOT, file)}:${i + 1}: ${m[1]} is given as ${m[2]}, but networks.ts says ${want}`);
    }
  });
}

if (problems.length) {
  console.error(`Contract address check failed (${problems.length}):\n` + problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Contract addresses OK in ${files.length} files (Kudo ${CURRENT.kudo}).`);
