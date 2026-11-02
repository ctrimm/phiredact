#!/usr/bin/env node
/**
 * CI checks for the phiredact static site.
 *
 * Two gates, both aimed at regressions this site has actually shipped:
 *   1. Overflow — every page at phone / tablet / desktop widths must not
 *      scroll horizontally (documentElement.scrollWidth <= clientWidth).
 *      Wide tables may scroll inside their own labelled region; the page
 *      body may not. This is the regression PR #1 fixed.
 *   2. Accessibility — axe-core with the WCAG 2.1 A/AA tag set
 *      (wcag2a + wcag2aa + wcag21a + wcag21aa; axe tags are cumulative,
 *      auditing 2.1 needs all four) must report zero violations.
 *
 * The site root is served with a minimal static server (Node built-ins
 * only) and driven in Chromium via Playwright. Set CHROME_PATH to use a
 * specific Chrome/Chromium binary; when unset (CI) Playwright's bundled
 * Chromium is used.
 *
 * Usage: node scripts/check.mjs [siteRoot]
 *   siteRoot defaults to the repository root (the parent of scripts/).
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PAGES = ["/", "/demo/", "/benchmarks/", "/mac/", "/extension/"];
const OVERFLOW_WIDTHS = [320, 390, 768, 1440];
const AXE_WIDTHS = [390, 1440];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const siteRoot = resolve(process.argv[2] ?? join(scriptDir, ".."));
const axeSource = await readFile(
  join(scriptDir, "..", "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let filePath = normalize(join(root, urlPath));
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      if ((await stat(filePath).catch(() => null))?.isDirectory()) {
        filePath = join(filePath, "index.html");
      }
      const body = await readFile(filePath);
      res
        .writeHead(200, {
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        })
        .end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => res(server));
  });
}

const failures = [];
const server = await startServer(siteRoot);
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox", "--no-proxy-server"],
  });

  // ---- Gate 1: horizontal overflow -------------------------------------
  for (const width of OVERFLOW_WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    for (const path of PAGES) {
      await page.goto(base + path, { waitUntil: "load" });
      await page.waitForTimeout(150);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (scrollWidth > clientWidth) {
        failures.push(
          `OVERFLOW ${path} @${width}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`,
        );
      }
    }
    await page.close();
  }
  console.log(
    `overflow: ${PAGES.length * OVERFLOW_WIDTHS.length} page/width combinations checked`,
  );

  // ---- Gate 2: axe-core WCAG 2.1 A/AA ----------------------------------
  for (const width of AXE_WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    for (const path of PAGES) {
      await page.goto(base + path, { waitUntil: "load" });
      await page.waitForTimeout(150);
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async (tags) => {
        const results = await window.axe.run(document, {
          runOnly: { type: "tag", values: tags },
        });
        return results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target.join(" ")),
        }));
      }, AXE_TAGS);
      for (const v of violations) {
        for (const target of v.targets) {
          failures.push(`A11Y ${path} @${width}px: ${v.id} (${v.impact}) at ${target}`);
        }
      }
    }
    await page.close();
  }
  console.log(
    `axe: ${PAGES.length * AXE_WIDTHS.length} page/width combinations checked (tags: ${AXE_TAGS.join(", ")})`,
  );
} finally {
  await browser?.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("\nPASS — no horizontal overflow, no axe WCAG 2.1 A/AA violations.");
