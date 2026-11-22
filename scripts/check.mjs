#!/usr/bin/env node
/**
 * CI checks for the phiredact static site.
 *
 * Four gates, aimed at regressions this site has actually shipped or
 * could silently ship:
 *   1. Overflow — every page at phone / tablet / desktop widths must not
 *      scroll horizontally (documentElement.scrollWidth <= clientWidth).
 *      Wide tables may scroll inside their own labelled region; the page
 *      body may not. This is the regression PR #1 fixed.
 *   2. Accessibility — axe-core with the WCAG 2.1 A/AA tag set
 *      (wcag2a + wcag2aa + wcag21a + wcag21aa; axe tags are cumulative,
 *      auditing 2.1 needs all four) must report zero violations.
 *   3. Nav behaviour — at phone width the header's hamburger must open
 *      and close the link panel (aria-expanded in sync, Escape and
 *      outside-tap close it), and axe must stay clean with the menu
 *      open: the closed-menu axe pass cannot see a dead toggle or a
 *      broken dropdown. At desktop width the toggle hides and the
 *      links show inline.
 *   4. Links — every internal href on every page must resolve on the
 *      local server, and every Mac download button must point at one
 *      identical, well-formed GitHub release URL for PHI-Redact.dmg.
 *      When the network allows, that URL is also fetched and must
 *      answer 200 (a typo'd release tag 404s silently otherwise);
 *      offline runs log a warning and skip only that fetch.
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
const ALL_PAGES = [...PAGES, "/privacy/", "/terms/"];
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

  // ---- Gate 3: mobile nav behaviour ------------------------------------
  const navState = (page) =>
    page.evaluate(() => {
      const toggle = document.querySelector(".nav-toggle");
      const links = document.getElementById("nav-links");
      const visible = (el) =>
        !!el &&
        el.getBoundingClientRect().height > 0 &&
        getComputedStyle(el).display !== "none";
      return {
        toggleVisible: visible(toggle),
        linksVisible: visible(links),
        expanded: toggle?.getAttribute("aria-expanded"),
        linkCount: links ? links.querySelectorAll("a").length : 0,
      };
    });

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    for (const path of ALL_PAGES) {
      await page.goto(base + path, { waitUntil: "load" });
      await page.waitForTimeout(150);
      let state = await navState(page);
      if (!state.toggleVisible) {
        failures.push(`NAV ${path} @390px: hamburger toggle not visible`);
      }
      if (state.linksVisible) {
        failures.push(`NAV ${path} @390px: link panel visible before toggle`);
      }
      await page.click(".nav-toggle");
      await page.waitForTimeout(100);
      state = await navState(page);
      if (!state.linksVisible) {
        failures.push(`NAV ${path} @390px: link panel did not open on toggle`);
      }
      if (state.expanded !== "true") {
        failures.push(
          `NAV ${path} @390px: aria-expanded=${state.expanded} after opening`,
        );
      }
      if (state.linkCount < 5) {
        failures.push(
          `NAV ${path} @390px: only ${state.linkCount} links in the open panel`,
        );
      }
      // Axe must stay clean with the menu open, not just closed.
      if (path === "/" || path === "/mac/") {
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
            failures.push(
              `A11Y-OPEN ${path} @390px: ${v.id} (${v.impact}) at ${target}`,
            );
          }
        }
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      state = await navState(page);
      if (state.linksVisible || state.expanded !== "false") {
        failures.push(`NAV ${path} @390px: Escape did not close the panel`);
      }
      await page.click(".nav-toggle");
      await page.waitForTimeout(100);
      // Outside tap: dispatch on <main> rather than hit-testing a point,
      // so pages with interactive bodies (the demo) are not disturbed.
      await page.evaluate(() => {
        document
          .querySelector("main")
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(100);
      state = await navState(page);
      if (state.linksVisible) {
        failures.push(`NAV ${path} @390px: outside tap did not close the panel`);
      }
    }
    await page.close();

    const desk = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await desk.goto(base + "/", { waitUntil: "load" });
    await desk.waitForTimeout(150);
    const deskState = await navState(desk);
    if (deskState.toggleVisible) {
      failures.push("NAV / @1440px: hamburger toggle should be hidden");
    }
    if (!deskState.linksVisible) {
      failures.push("NAV / @1440px: links should be visible inline");
    }
    await desk.close();
  }
  console.log(
    `nav: toggle open/close verified on ${ALL_PAGES.length} pages @390px + desktop state`,
  );

  // ---- Gate 4: link integrity + the Mac download URL --------------------
  {
    const dmgUrls = new Set();
    const internal = new Set();
    for (const path of ALL_PAGES) {
      const res = await fetch(base + path);
      const html = await res.text();
      for (const match of html.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
        const href = match[1];
        if (href.includes("PHI-Redact.dmg")) dmgUrls.add(href);
        if (/^(https?:|mailto:|#)/.test(href)) continue;
        internal.add(new URL(href, base + path).href);
      }
    }
    for (const url of internal) {
      const res = await fetch(url).catch(() => null);
      if (!res || res.status !== 200) {
        failures.push(
          `LINK ${url.replace(base, "")}: status ${res ? res.status : "fetch failed"}`,
        );
      }
    }
    console.log(
      `links: ${internal.size} internal hrefs resolved across ${ALL_PAGES.length} pages`,
    );

    const DMG_PATTERN =
      /^https:\/\/github\.com\/ctrimm\/phiredact\/releases\/download\/v\d+\.\d+\.\d+\/PHI-Redact\.dmg$/;
    if (dmgUrls.size !== 1) {
      failures.push(
        `DOWNLOAD: expected exactly 1 distinct DMG URL, found ${dmgUrls.size}: ${[...dmgUrls].join(", ")}`,
      );
    } else {
      const [dmg] = dmgUrls;
      if (!DMG_PATTERN.test(dmg)) {
        failures.push(`DOWNLOAD: malformed release URL: ${dmg}`);
      } else {
        const head = await fetch(dmg, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        }).catch(() => null);
        if (head === null) {
          console.warn(
            `download: could not reach ${dmg} (offline?) — live check skipped`,
          );
        } else if (head.status !== 200) {
          failures.push(`DOWNLOAD: ${dmg} answered ${head.status}, expected 200`);
        } else {
          console.log(`download: ${dmg} answers 200`);
        }
      }
    }
  }
} finally {
  await browser?.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  "\nPASS — no overflow, no axe violations, nav opens/closes on every page, all links resolve.",
);
