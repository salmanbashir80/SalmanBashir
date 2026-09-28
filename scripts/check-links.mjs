#!/usr/bin/env node
/**
 * External link checker — zero dependencies (Node 18+).
 *
 * Scans project source files for http(s) URLs, dedupes them, checks each one
 * (HEAD, falling back to GET) and classifies the result:
 *
 *   OK       2xx/3xx final status
 *   BLOCKED  bot protection (403/429/999 or Cloudflare challenge) — not a failure
 *   BROKEN   404/410 (and GitHub API-confirmed 404s) — hard failure, opens an issue in CI
 *   ERROR    timeouts / 5xx after one retry — reported, not a hard failure
 *
 * Usage:
 *   node scripts/check-links.mjs                 # human-readable output
 *   node scripts/check-links.mjs --json out.json # also write JSON report for CI
 *
 * Exit codes: 0 = no broken links, 1 = broken links found.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, sep, extname } from "node:path";

const ROOT = process.cwd();

// Directories scanned for URLs (source of truth = data files + markup).
const SCAN_DIRS = ["src", "public", "scripts", "api"];
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".xml", ".html", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".vercel", ".git", ".freebuff", "coverage"]);

// URL fragments that are template placeholders, not real links.
const URL_PATTERN = /https?:\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
const IGNORE_PATTERNS = [
  /localhost/,
  /127\.0\.0\.1/,
  /example\.com/,
  /\{\{/,
  /\$\{/,
  /your-/,
  /<[^>]+>/,
  /schemas\.vercel\.sh/, // JSON schema reference, not a link
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /pagead2\.googlesyndication\.com/,
  /komarev\.com/, // badge service used in profile READMEs only
  /\$$/, // template-literal tail like https://github.com/${owner} cut at $
];

// POST-only API endpoints return 404 on GET by design — not broken.
const KNOWN_POST_ENDPOINTS = ["https://openrouter.ai/api/v1/chat/completions"];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Statuses that mean "bot blocked us", not "link is broken".
const BLOCKED_STATUSES = new Set([401, 403, 406, 412, 418, 429, 503, 999]);

const jsonArgIdx = process.argv.indexOf("--json");
const JSON_OUT = jsonArgIdx !== -1 ? process.argv[jsonArgIdx + 1] : null;
const TIMEOUT_MS = 15_000;

async function extractFiles(dir, files = []) {
  let entries;
  try {      entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await extractFiles(join(dir, entry.name), files);
    } else if (SCAN_EXT.has(extname(entry.name).toLowerCase())) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

async function collectUrls() {
  const urls = new Map(); // url -> first source location
  for (const dir of SCAN_DIRS) {
    const files = await extractFiles(join(ROOT, dir));
    for (const file of files) {
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(URL_PATTERN)) {
        let url = match[0].replace(/[.,;)'"]+$/, ""); // trim trailing punctuation
        if (IGNORE_PATTERNS.some((re) => re.test(url))) continue;
        if (!urls.has(url)) urls.set(url, relative(ROOT, file).split(sep).join("/"));
      }
    }
  }
  return urls;
}

async function checkUrl(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      // Cloudflare-style challenge pages return 403 with a challenge header.
      const cfChallenge = res.headers.get("server")?.toLowerCase().includes("cloudflare") && res.status === 403;

      if (res.ok) return { url, status: res.status, verdict: "OK" };
      if (BLOCKED_STATUSES.has(res.status) || cfChallenge) {
        return { url, status: res.status, verdict: "BLOCKED" };
      }
      if (method === "GET") {
        if ((res.status === 404 || res.status === 410) && KNOWN_POST_ENDPOINTS.some((ep) => url.startsWith(ep))) {
          return { url, status: res.status, verdict: "OK", reason: "POST-only API endpoint (GET 404 expected)" };
        }
        return { url, status: res.status, verdict: res.status === 404 || res.status === 410 ? "BROKEN" : "ERROR" };
      }
      // Some servers reject HEAD specifically — fall through to GET.
    } catch (err) {
      if (method === "GET") {
        const reason = err?.cause?.code || err?.name || "UNKNOWN";
        return { url, status: 0, verdict: "ERROR", reason };
      }
    }
  }
}

// GitHub URLs: verify via the API (repo redirects hide renames/deletions).
async function verifyGithub(url) {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const [, owner, repo] = m;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "link-checker",
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (res.status === 200) return null; // fine
    if (res.status === 404) {
      return `GitHub API reports 404 for ${owner}/${repo} (redirects may be hiding a rename or deletion)`;
    }
  } catch {
    /* API unreachable — skip this extra check */
  }
  return null;
}

async function main() {
  console.log("Collecting external URLs from source files...\n");
  const urls = await collectUrls();
  console.log(`Found ${urls.size} unique URLs. Checking...\n`);

  const results = [];
  const queue = [...urls.keys()];
  const CONCURRENCY = 8;
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map((u) => checkUrl(u)));
    for (const r of settled) {
      // Attach the first source file where this URL appeared.
      r.source = urls.get(r.url) || "?";
      results.push(r);
      const icon = { OK: "✅", BLOCKED: "🛡️ ", BROKEN: "❌", ERROR: "⚠️ " }[r.verdict];
      const extra = r.verdict === "ERROR" && r.reason ? ` (${r.reason})` : "";
      console.log(`${icon} [${r.verdict}] ${r.status || "-"} ${r.url}${extra}   -> ${r.source}`);
    }
  }

  // Extra: GitHub API verification for repo links (catches renamed accounts).
  const githubUrls = results.filter((r) => r.verdict === "OK" && /^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(r.url));
  if (githubUrls.length) {
    console.log(`\nVerifying ${githubUrls.length} GitHub repo links via API...\n`);
    for (const r of githubUrls) {
      const problem = await verifyGithub(r.url);
      if (problem) {
        r.verdict = "BROKEN";
        r.reason = problem;
        console.log(`❌ [BROKEN] ${r.url} — ${problem}   -> ${r.source}`);
      }
    }
  }

  const broken = results.filter((r) => r.verdict === "BROKEN");
  const errors = results.filter((r) => r.verdict === "ERROR");
  const blocked = results.filter((r) => r.verdict === "BLOCKED");

  console.log(`\n===== SUMMARY =====`);
  console.log(`OK:      ${results.length - broken.length - errors.length - blocked.length}`);
  console.log(`BLOCKED: ${blocked.length}  (bot protection — treated as OK)`);
  console.log(`ERROR:   ${errors.length}  (timeouts/5xx — informational)`);
  console.log(`BROKEN:  ${broken.length}  ${broken.length ? "❌ ACTION NEEDED" : "✅"}`);

  for (const b of broken) console.log(`  ❌ ${b.url}   (${b.source}${b.reason ? ` — ${b.reason}` : ""})`);

  if (JSON_OUT) {
    await mkdir(join(ROOT, JSON_OUT, ".."), { recursive: true }).catch(() => {});
    await writeFile(
      join(ROOT, JSON_OUT),
      JSON.stringify({ checkedAt: new Date().toISOString(), total: results.length, broken, errors, blocked }, null, 2),
    );
    console.log(`\nJSON report written to ${JSON_OUT}`);
  }

  process.exit(broken.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Link checker crashed:", err);
  process.exit(1);
});
