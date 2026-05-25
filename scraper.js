import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import {
  CONFIG,
  SEEK,
  delay,
  ensureSeekSession,
  ensureStillLoggedIn,
  launchSeekBrowser,
  logPasswordDiagnostics,
  safeGoto,
} from "./seek-auth.js";
import fs from "fs";
import {
  clickYourCandidatesRowByPhone,
  createNetworkCollector,
  extractCandidateCardsFromDom,
  extractCandidateDetailFromModal,
  extractJobIdsFromPageHtml,
  extractYourCandidatesFromDom,
  mergeApiFieldsIntoCandidate,
} from "./seek-extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

const CHECKPOINT_PATH =
  process.env.SCRAPE_CHECKPOINT || path.join(__dirname, "scrape-checkpoint.json");

/** Phase 1: fast list only. Phase 2: TURBO_ENRICH=true for email+location+resume */
const TURBO_MODE = process.env.TURBO_MODE === "true";

const SCRAPER_CONFIG = {
  nuanuApiUrl: process.env.NUANU_API_URL,
  nuanuApiKey: process.env.NUANU_API_KEY,
  headless: process.env.HEADLESS === "true",
  scrapeJobs: process.env.SCRAPE_JOBS === "true",
  startPage: Math.max(1, parseInt(process.env.START_PAGE || "1", 10)),
  maxPages: Math.min(500, Math.max(1, parseInt(process.env.MAX_PAGES || "1", 10))),
  maxAgeMonths: Math.max(0, parseInt(process.env.MAX_AGE_MONTHS || "0", 10)),
  maxJobs: parseInt(process.env.MAX_JOBS || "20", 10),
  delayMs: TURBO_MODE
    ? parseInt(process.env.DELAY_MS || "1200", 10)
    : parseInt(process.env.DELAY_MS || "3500", 10),
  listSettleMs: TURBO_MODE
    ? parseInt(process.env.LIST_SETTLE_MS || "2000", 10)
    : parseInt(process.env.LIST_SETTLE_MS || "4500", 10),
  profileSettleMs: TURBO_MODE
    ? parseInt(process.env.PROFILE_SETTLE_MS || "700", 10)
    : parseInt(process.env.PROFILE_SETTLE_MS || "1200", 10),
  scrapeOnly: process.env.SCRAPE_ONLY === "true",
  fetchContactDetails: TURBO_MODE
    ? process.env.FETCH_CONTACT_DETAILS === "true"
    : process.env.FETCH_CONTACT_DETAILS !== "false",
  maxDetailCandidates: parseInt(process.env.MAX_DETAIL_CANDIDATES || "0", 10),
  jobSiteManager: process.env.SEEK_JOB_SITE_MANAGER || "",
  jobAccountingOfficer: process.env.SEEK_JOB_ACCOUNTING_OFFICER || "",
  resumeCheckpoint: process.env.RESUME_CHECKPOINT === "true",
  saveCheckpoint: process.env.SAVE_CHECKPOINT !== "false",
  /** Phase 2: enrich checkpoint (email, phone, location, resume) then optional ATS import */
  turboEnrich: process.env.TURBO_ENRICH === "true",
  turboEnrichCheckpoint:
    process.env.TURBO_ENRICH_CHECKPOINT || CHECKPOINT_PATH,
  /** Scrape N list pages at once (same login; do not use with fetchContactDetails on list) */
  parallelListPages: Math.min(
    5,
    Math.max(1, parseInt(process.env.PARALLEL_LIST_PAGES || "1", 10)),
  ),
  /** Phase 2: open profile URLs on N browser tabs in parallel (2–3 recommended) */
  enrichConcurrency: Math.min(
    4,
    Math.max(1, parseInt(process.env.ENRICH_CONCURRENCY || "2", 10)),
  ),
};

if (!SCRAPER_CONFIG.scrapeOnly && (!SCRAPER_CONFIG.nuanuApiUrl || !SCRAPER_CONFIG.nuanuApiKey)) {
  console.error("❌ Missing NUANU_API_URL or NUANU_API_KEY in .env (or set SCRAPE_ONLY=true)");
  process.exit(1);
}

function candidateKey(c) {
  const email = (c.email || "").toLowerCase().trim();
  const phone = (c.phone || "").replace(/\D/g, "");
  const name = (c.name || "").toLowerCase().trim();
  return `${name}|${phone}|${email}`;
}

function isValidYourCandidatesRow(c) {
  if (!c?.name || !c?.phone) return false;
  const name = c.name.trim();
  if (name.length < 4) return false;
  if (/^(South|West|North|East|Sarjana|Diploma|Magister)\b/i.test(name)) return false;
  if (/,\s*\d{4}|@\s*/.test(name)) return false;
  const digits = (c.phone || "").replace(/\D/g, "");
  if (digits.length < 10) return false;
  if (c.appliedRole) {
    const role = c.appliedRole.trim();
    if (role.length >= 50) return false;
  }
  return true;
}

function dedupeCandidates(list) {
  const seen = new Set();
  return list.filter((c) => {
    if (!isValidYourCandidatesRow(c)) return false;
    const key = candidateKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const NAV_OPTS = { waitUntil: "domcontentloaded", timeout: 60000 };

async function gotoSeekPage(page, url) {
  await safeGoto(page, url);
  await delay(SCRAPER_CONFIG.delayMs);
}

function mergeCandidates(target, incoming) {
  const seen = new Set(target.map((c) => candidateKey(c)));
  for (const c of incoming) {
    const key = candidateKey(c);
    if (!c.name || seen.has(key)) continue;
    seen.add(key);
    target.push(c);
  }
}

async function logDomDiagnostics(page, context) {
  const diag = await page
    .evaluate(() => {
      const automations = {};
      document.querySelectorAll("[data-automation]").forEach((el) => {
        const key = el.getAttribute("data-automation");
        automations[key] = (automations[key] || 0) + 1;
      });
      return {
        url: location.href,
        tr: document.querySelectorAll("table tbody tr").length,
        roleRows: document.querySelectorAll('[role="row"]').length,
        articles: document.querySelectorAll("article").length,
        candidateLinks: document.querySelectorAll(
          'a[href*="candidates"], a[href*="selected="]',
        ).length,
        dataAutomationCounts: Object.entries(automations).slice(0, 25),
        sampleText: document.body?.innerText?.slice(0, 400),
      };
    })
    .catch(() => ({ error: "evaluate failed" }));

  console.log(`  🔍 DOM diagnostics (${context}):`, JSON.stringify(diag, null, 2));
}

async function ensurePastApplicantsTab(page) {
  const pastTab = page
    .locator('button, [role="tab"], a')
    .filter({ hasText: /^Past applicants$/i })
    .first();

  if (await pastTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    const selected =
      (await pastTab.getAttribute("aria-selected")) === "true" ||
      (await pastTab.getAttribute("aria-current")) === "page";
    if (!selected) {
      console.log('  Clicking "Past applicants" tab...');
      await pastTab.click();
      await delay(SCRAPER_CONFIG.delayMs);
    }
  }
}

async function dismissSeekOverlays(page) {
  await page.keyboard.press("Escape").catch(() => {});
  const close = page.locator(
    '#braid-modal-container button[aria-label="Close"], #braid-modal-container button:has-text("Close"), [aria-label="Dismiss"]',
  );
  if (await close.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    await close.first().click().catch(() => {});
    await delay(500);
  }
}

async function scrapeOneListPage(page, context, pageNum, network) {
  const url = SEEK.yourCandidatesPage(pageNum);
  console.log(`📄 Page ${pageNum}/${SCRAPER_CONFIG.maxPages}: ${url}`);

  await dismissSeekOverlays(page);
  await gotoSeekPage(page, url);

  if (!page.url().includes("your-candidates")) {
    console.log("  ↻ Wrong page after navigation — reopening your-candidates");
    await gotoSeekPage(page, url);
  }

  await ensureStillLoggedIn(context, page);
  await ensurePastApplicantsTab(page);
  await waitForCandidatesListReady(page);

  const pageCandidates = await page.evaluate(extractYourCandidatesFromDom);
  console.log(`  Found ${pageCandidates.length} candidates on page ${pageNum}`);

  if (pageCandidates.length === 0) {
    if (pageNum === SCRAPER_CONFIG.startPage) {
      await logDomDiagnostics(page, "your-candidates");
    }
    return { empty: true, reachedAgeCutoff: false, withinWindow: [], pageCandidates };
  }

  const withinWindow =
    SCRAPER_CONFIG.maxAgeMonths > 0
      ? pageCandidates.filter((c) =>
          isWithinMaxAgeMonths(c.appliedAt, SCRAPER_CONFIG.maxAgeMonths),
        )
      : pageCandidates;

  const skippedByAge = pageCandidates.length - withinWindow.length;
  if (skippedByAge > 0) {
    console.log(
      `  ⏳ Skipped ${skippedByAge} on this page (older than ${SCRAPER_CONFIG.maxAgeMonths} months)`,
    );
  }

  const oldestOnPage = pageCandidates[pageCandidates.length - 1];
  const reachedAgeCutoff =
    SCRAPER_CONFIG.maxAgeMonths > 0 &&
    oldestOnPage &&
    !isWithinMaxAgeMonths(oldestOnPage.appliedAt, SCRAPER_CONFIG.maxAgeMonths);

  if (SCRAPER_CONFIG.fetchContactDetails && withinWindow.length > 0) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    await enrichYourCandidatesOnPage(page, withinWindow, 0, url, network);
  }

  return { empty: false, reachedAgeCutoff, withinWindow, pageCandidates };
}

async function scrapeCandidatesPage(page, context, network) {
  let candidates = [];
  let consecutiveEmpty = 0;

  const checkpoint = SCRAPER_CONFIG.resumeCheckpoint ? loadScrapeCheckpoint() : null;
  let pageNum = SCRAPER_CONFIG.startPage;

  if (checkpoint?.candidates?.length) {
    candidates = checkpoint.candidates;
    pageNum = (checkpoint.lastPage || SCRAPER_CONFIG.startPage) + 1;
    console.log(
      `  📂 Resuming checkpoint: ${candidates.length} candidates, starting at page ${pageNum}`,
    );
  }

  console.log("📋 Scraping https://id.employer.seek.com/your-candidates?page=N");
  console.log(
    `  Pages: ${pageNum}–${SCRAPER_CONFIG.maxPages}` +
      (SCRAPER_CONFIG.maxAgeMonths > 0
        ? ` (stop after ~${SCRAPER_CONFIG.maxAgeMonths} months)`
        : ""),
  );
  if (SCRAPER_CONFIG.parallelListPages > 1) {
    console.log(`  ⚡ Parallel list tabs: ${SCRAPER_CONFIG.parallelListPages}`);
  }
  if (SCRAPER_CONFIG.fetchContactDetails) {
    console.log("  📇 Will open each candidate profile for email + resume download");
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } else {
    console.log("  ⚡ List only (no profile opens on this run)");
  }

  const parallel = SCRAPER_CONFIG.parallelListPages;

  for (; pageNum <= SCRAPER_CONFIG.maxPages; ) {
    const batchNums = [];
    for (let i = 0; i < parallel && pageNum + i <= SCRAPER_CONFIG.maxPages; i++) {
      batchNums.push(pageNum + i);
    }

    let results;
    if (parallel > 1 && !SCRAPER_CONFIG.fetchContactDetails) {
      const tabs = await Promise.all(
        batchNums.map(async (num) => {
          const tab = await context.newPage();
          await attachNetworkSniffer(tab, network);
          const result = await scrapeOneListPage(tab, context, num, network);
          await tab.close().catch(() => {});
          return { pageNum: num, ...result };
        }),
      );
      results = tabs;
    } else {
      results = [
        {
          pageNum: batchNums[0],
          ...(await scrapeOneListPage(page, context, batchNums[0], network)),
        },
      ];
      pageNum = batchNums[0];
    }

    let stopRun = false;
    for (const result of results) {
      const num = result.pageNum;
      if (result.empty) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          console.log(
            `  ⏹ Stopping: ${consecutiveEmpty} empty pages in a row (end of SEEK list)`,
          );
          stopRun = true;
          break;
        }
        continue;
      }
      consecutiveEmpty = 0;
      mergeCandidates(candidates, result.withinWindow);
      saveScrapeCheckpoint(candidates, num);

      if (result.reachedAgeCutoff) {
        console.log(
          `  ⏹ Stopping: reached ${SCRAPER_CONFIG.maxAgeMonths}-month cutoff on page ${num}`,
        );
        stopRun = true;
        break;
      }
    }

    pageNum = batchNums[batchNums.length - 1] + 1;
    if (stopRun) break;
  }

  return candidates;
}

/**
 * Phase 2: open saved profileUrl for each row → email, phone, location, resume PDF.
 * Uses multiple browser tabs (ENRICH_CONCURRENCY) — much faster than one-by-one list clicks.
 */
async function enrichCheckpointCandidates(context, candidates, network) {
  const queue = candidates.filter((c) => needsProfileEnrich(c) && c.profileUrl);
  const noUrl = candidates.filter((c) => needsProfileEnrich(c) && !c.profileUrl);

  console.log(`\n⚡ Profile enrich: ${queue.length} with profileUrl, ${noUrl.length} without URL`);
  if (queue.length === 0) return 0;

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  let index = 0;
  let done = 0;
  const workers = SCRAPER_CONFIG.enrichConcurrency;

  async function worker(workerId) {
    const page = await context.newPage();
    await attachNetworkSniffer(page, network);

    while (true) {
      const i = index++;
      if (i >= queue.length) break;

      const candidate = queue[i];
      console.log(
        `  [w${workerId}] ${i + 1}/${queue.length} ${candidate.name}…`,
      );

      try {
        await enrichFromProfileUrl(page, candidate, candidate.profileUrl, null, network);
        done++;
        if (done % 10 === 0) {
          saveScrapeCheckpoint(candidates, loadScrapeCheckpoint()?.lastPage || 0);
        }
      } catch (err) {
        console.log(`      ⚠️  ${err.message}`);
      }

      await delay(SCRAPER_CONFIG.delayMs);
    }

    await page.close().catch(() => {});
  }

  await Promise.all(
    Array.from({ length: workers }, (_, workerId) => worker(workerId + 1)),
  );

  saveScrapeCheckpoint(candidates, loadScrapeCheckpoint()?.lastPage || 0);
  return done;
}

async function collectJobIdsFromPage(page, network) {
  const domJobs = await page.evaluate(extractJobIdsFromPageHtml);
  const jobs = new Map();

  for (const j of domJobs) jobs.set(j.jobId, j);
  for (const [, j] of network.jobs) jobs.set(j.jobId, j);

  return [...jobs.values()].sort((a, b) => b.candidateCount - a.candidateCount);
}

async function extractJobIdsFromAllSources(page, network) {
  const jobs = new Map();

  const add = (list) => {
    for (const j of list) {
      if (!j?.jobId) continue;
      const existing = jobs.get(j.jobId);
      if (!existing || (j.candidateCount || 0) > (existing.candidateCount || 0)) {
        jobs.set(j.jobId, j);
      }
    }
  };

  console.log("  Scanning dashboard for job links...");
  await gotoSeekPage(page, SEEK.dashboard);
  add(await collectJobIdsFromPage(page, network));

  console.log("  Scanning open jobs page...");
  await gotoSeekPage(page, SEEK.jobs);

  const openTab = page.locator('button, [role="tab"], a').filter({ hasText: /^Open$/i }).first();
  if (await openTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await openTab.click();
    await delay(1500);
  }

  add(await collectJobIdsFromPage(page, network));

  return [...jobs.values()].sort((a, b) => b.candidateCount - a.candidateCount);
}

async function scrapeJobPipelineFilters(page) {
  const filters = page.locator(
    'aside button, aside [role="button"], aside a, [data-automation*="pipeline"] button',
  );
  const count = await filters.count();
  const labels = [];
  const seen = new Set();

  for (let i = 0; i < Math.min(count, 20); i++) {
    const btn = filters.nth(i);
    const text = (await btn.textContent().catch(() => ""))?.trim();
    if (!text || text.length > 80) continue;
    if (!/Inbox|Prescreen|Shortlist|Interview|Offer|Accept|Not Suitable/i.test(text)) continue;
    if (!/\d/.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    labels.push({ index: i, text });
  }

  return labels;
}

async function fetchContactFromDetailPanel(page) {
  return page.evaluate(extractCandidateDetailFromModal).catch(() => ({
    email: null,
    phone: null,
    profileUrl: null,
    name: null,
  }));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNameKey(name) {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function phoneDigits(phone) {
  return (phone || "").replace(/\D/g, "");
}

async function waitForCandidateDetailModal(page) {
  await page
    .waitForFunction(
      () =>
        document.querySelector('a[href^="mailto:"]') ||
        document.querySelector("#braid-modal-container h1, #braid-modal-container h2"),
      { timeout: 25000 },
    )
    .catch(() => {});
  await delay(SCRAPER_CONFIG.profileSettleMs);
}

async function waitForCandidatesListReady(page) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await delay(400);

  await page
    .waitForFunction(
      () => {
        const links = document.querySelectorAll('a[href^="tel:"]');
        if (links.length === 0) return false;
        const first = links[0];
        const row = first.closest("tr") || first.closest('[role="row"]') || first.parentElement;
        const text = (row?.innerText || "").trim();
        return text.length > 20 && /\+?\d/.test(text);
      },
      { timeout: 40000 },
    )
    .catch(() => console.log("  Waiting for candidate rows timed out"));

  // Let SEEK finish rendering the first (newest) rows
  let lastCount = 0;
  let stablePasses = 0;
  for (let i = 0; i < 12; i++) {
    const count = await page
      .locator('a[href^="tel:"]')
      .count()
      .catch(() => 0);
    if (count === lastCount && count > 0) stablePasses++;
    else stablePasses = 0;
    lastCount = count;
    if (stablePasses >= 2) break;
    await delay(600);
  }

  await delay(SCRAPER_CONFIG.listSettleMs);
}

async function downloadResumeFromModal(page, candidateName) {
  const modal = page.locator("#braid-modal-container, [role='dialog']").first();
  const resumeTab = modal.getByRole("tab", { name: /^R[eé]sum[eé]$/i }).first();
  if (await resumeTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await resumeTab.click().catch(() => {});
    await delay(1200);
  }

  const downloadBtn = modal
    .locator(
      '[aria-label="Download document"], [title="Download document"], button:has-text("Download")',
    )
    .first();

  if (!(await downloadBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
    return null;
  }

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 45000 }),
      downloadBtn.click(),
    ]);
    const safeName = (candidateName || "candidate").replace(/[^\w.-]+/g, "_").slice(0, 60);
    const dest = path.join(DOWNLOADS_DIR, `${safeName}_${download.suggestedFilename()}`);
    await download.saveAs(dest);
    return dest;
  } catch (err) {
    console.log(`      ⚠️  Resume download failed: ${err.message}`);
    return null;
  }
}

async function closeCandidateDetail(page, returnUrl) {
  await page.keyboard.press("Escape").catch(() => {});
  const closeBtn = page.locator(
    '#braid-modal-container button[aria-label="Close"], #braid-modal-container button:has-text("Close")',
  );
  if (await closeBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeBtn.first().click().catch(() => {});
  }
  await dismissSeekOverlays(page);
  if (returnUrl && !page.url().includes("your-candidates")) {
    await safeGoto(page, returnUrl);
    await page.waitForSelector('a[href^="tel:"]', { timeout: 25000 }).catch(() => {});
    await delay(800);
  }
}

async function captureProfileDetails(page, candidate, network) {
  if (network) drainNetworkCandidatesInto(network, candidate);

  const detail = await fetchContactFromDetailPanel(page);
  if (detail.email) candidate.email = detail.email;
  if (detail.phone) candidate.phone = detail.phone;
  if (detail.profileUrl) candidate.profileUrl = detail.profileUrl;
  if (detail.location) {
    candidate.location = detail.location;
    candidate.domicile = detail.location;
    console.log(`      📍 ${detail.location}`);
  }

  if (network) drainNetworkCandidatesInto(network, candidate);

  const resumePath = await downloadResumeFromModal(page, candidate.name);
  if (resumePath) {
    candidate.resumeLocalPath = resumePath;
    console.log(`      📎 Resume: ${path.basename(resumePath)}`);
  }

  return Boolean(candidate.email);
}

async function enrichFromProfileUrl(page, candidate, profileUrl, returnUrl, network) {
  await dismissSeekOverlays(page);
  await safeGoto(page, profileUrl);
  await waitForCandidateDetailModal(page);

  const ok = await captureProfileDetails(page, candidate, network);
  if (ok) {
    console.log(`      ✉️  ${candidate.email} | ${candidate.phone || "—"}`);
  } else {
    console.log(`      ⚠️  No email in profile (phone: ${candidate.phone || "—"})`);
  }

  if (returnUrl) await closeCandidateDetail(page, returnUrl);
  return ok;
}

async function openCandidateProfile(page, candidate, returnUrl, network) {
  try {
    if (candidate.profileUrl) {
      return enrichFromProfileUrl(
        page,
        candidate,
        candidate.profileUrl,
        returnUrl,
        network,
      );
    }

    const digits = phoneDigits(candidate.phone);
    const clickResult = await page
      .evaluate(clickYourCandidatesRowByPhone, digits)
      .catch(() => ({ ok: false, reason: "evaluate failed" }));

    if (!clickResult?.ok) return false;

    await waitForCandidateDetailModal(page);
    const ok = await captureProfileDetails(page, candidate, network);
    if (ok) {
      console.log(`      ✉️  ${candidate.email} (${clickResult.method})`);
    }
    return ok;
  } finally {
    if (returnUrl) await closeCandidateDetail(page, returnUrl);
  }
}

async function buildRoleJobMap(page, network) {
  const map = new Map();

  if (SCRAPER_CONFIG.jobSiteManager) {
    map.set("Site Manager", SCRAPER_CONFIG.jobSiteManager.replace(/\D/g, ""));
  }
  if (SCRAPER_CONFIG.jobAccountingOfficer) {
    map.set("Accounting Officer", SCRAPER_CONFIG.jobAccountingOfficer.replace(/\D/g, ""));
  }

  const jobs = await extractJobIdsFromAllSources(page, network);
  for (const job of jobs) {
    const title = (job.title || "").trim();
    if (/site\s*manager/i.test(title)) map.set("Site Manager", job.jobId);
    if (/accounting\s*officer/i.test(title)) map.set("Accounting Officer", job.jobId);
  }

  return map;
}

async function collectProfileLinksForJob(page, context, jobId, network) {
  const profiles = new Map();

  const addLinks = async (label) => {
    const links = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href*="selected="]')]
        .map((a) => {
          const card =
            a.closest("li, article, [role='row'], [data-automation], div") || a.parentElement;
          const name =
            card?.querySelector("h1, h2, h3, h4, strong")?.textContent?.trim() ||
            a.textContent?.trim() ||
            "";
          return { href: a.href, name };
        })
        .filter((x) => x.href && x.name && x.name.length > 2);
    });

    let added = 0;
    for (const link of links) {
      const key = normalizeNameKey(link.name);
      if (!profiles.has(key)) {
        profiles.set(key, link.href);
        added++;
      }
    }
    if (added > 0 && label) console.log(`    ${label}: +${added} profile URLs`);
  };

  network.candidates.length = 0;
  await gotoSeekPage(page, SEEK.candidatesForJob(jobId));
  await ensureStillLoggedIn(context, page);

  await page
    .waitForFunction(
      () => document.querySelectorAll('a[href*="selected="]').length > 0,
      { timeout: 35000 },
    )
    .catch(() => {});

  await addLinks("Inbox (default)");

  const filters = await scrapeJobPipelineFilters(page);
  if (filters.length > 0) {
    const filterLocator = page.locator(
      'aside button, aside [role="button"], aside a, [data-automation*="pipeline"] button',
    );
    for (const { index, text } of filters) {
      await filterLocator.nth(index).click().catch(() => {});
      await delay(1500);
      await addLinks(`Filter "${text}"`);
    }
  }

  return profiles;
}

function findProfileUrlForCandidate(profileMap, name) {
  const key = normalizeNameKey(name);
  if (profileMap.has(key)) return profileMap.get(key);

  for (const [mapKey, href] of profileMap) {
    if (mapKey.includes(key) || key.includes(mapKey)) return href;
  }

  const keyWords = key.split(" ").filter((w) => w.length > 2);
  for (const [mapKey, href] of profileMap) {
    const matched = keyWords.filter((w) => mapKey.includes(w)).length;
    if (matched >= Math.min(2, keyWords.length)) return href;
  }

  return null;
}

async function enrichCandidatesViaJobPipelines(page, context, candidates, network) {
  const roleJobMap = await buildRoleJobMap(page, network);
  if (roleJobMap.size === 0) {
    console.log("  ⚠️  No job IDs found — set SEEK_JOB_SITE_MANAGER / SEEK_JOB_ACCOUNTING_OFFICER in .env");
    return 0;
  }

  let enriched = 0;

  for (const [role, jobId] of roleJobMap) {
    const roleCandidates = candidates.filter((c) => c.appliedRole === role && !c.email);
    if (roleCandidates.length === 0) continue;

    console.log(
      `\n  📋 Job pipeline "${role}" (jobId=${jobId}) — ${roleCandidates.length} candidates need email…`,
    );

    const profileMap = await collectProfileLinksForJob(page, context, jobId, network);
    console.log(`    Collected ${profileMap.size} unique profile URLs`);

    for (const candidate of roleCandidates) {
      const profileUrl = findProfileUrlForCandidate(profileMap, candidate.name);
      if (!profileUrl) {
        console.log(`    ⚠️  No profile URL for ${candidate.name}`);
        continue;
      }

      console.log(`    👤 ${candidate.name}…`);
      try {
        if (await enrichFromProfileUrl(page, candidate, profileUrl, null, network))
          enriched++;
      } catch (err) {
        console.log(`      ⚠️  ${err.message}`);
      }
      await delay(SCRAPER_CONFIG.delayMs);
    }
  }

  return enriched;
}

async function enrichYourCandidatesOnPage(
  page,
  pageCandidates,
  maxToOpen,
  listPageUrl,
  network,
) {
  let enriched = 0;
  let detailCount = 0;

  for (const candidate of pageCandidates) {
    if (maxToOpen > 0 && detailCount >= maxToOpen) break;

    const label = candidate.name;
    console.log(`  👤 Opening profile: ${label}…`);

    await dismissSeekOverlays(page);

    detailCount++;
    const gotEmail = await openCandidateProfile(page, candidate, listPageUrl, network);
    if (gotEmail) enriched++;
    else if (!candidate.profileUrl) {
      console.log(`      ⚠️  Could not open profile for ${label} (will retry via job pipeline)`);
    }

    await delay(SCRAPER_CONFIG.delayMs);
  }

  if (detailCount > 0) {
    console.log(`  📇 Enriched ${enriched}/${detailCount} profiles on this page`);
  }

  return { enriched, detailCount };
}

async function scrapeJobCandidates(page, context, jobId, jobTitle, network) {
  const url = SEEK.candidatesForJob(jobId);
  network.candidates.length = 0;

  await gotoSeekPage(page, url);
  await ensureStillLoggedIn(context, page);

  await page
    .waitForFunction(
      () =>
        document.body?.innerText?.includes("Applications") ||
        document.body?.innerText?.includes("Applied") ||
        document.querySelectorAll('a[href*="selected="]').length > 0,
      { timeout: 35000 },
    )
    .catch(() => {
      console.log("    Waiting for applications list timed out");
    });

  const title =
    jobTitle ||
    (await page
      .locator("h1, h2")
      .first()
      .textContent()
      .catch(() => null))?.trim() ||
    "Unknown Role";

  const collected = [];
  const seen = new Set();

  const merge = (batch, label) => {
    let added = 0;
    for (const c of batch) {
      const key = candidateKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(c);
      added++;
    }
    if (added > 0 && label) {
      console.log(`    ${label}: +${added} candidates`);
    }
  };

  merge(await page.evaluate(extractCandidateCardsFromDom, title), "Inbox (default view)");
  merge([...network.candidates], "API responses");

  const filters = await scrapeJobPipelineFilters(page);
  if (filters.length > 0) {
    const filterLocator = page.locator(
      'aside button, aside [role="button"], aside a, [data-automation*="pipeline"] button',
    );
    for (const { index, text } of filters) {
      network.candidates.length = 0;
      await filterLocator.nth(index).click().catch(() => {});
      await delay(1500);
      const batch = await page.evaluate(extractCandidateCardsFromDom, title);
      merge(batch, `Filter "${text}"`);
      merge([...network.candidates], `Filter "${text}" (API)`);
    }
  }

  if (SCRAPER_CONFIG.fetchContactDetails && collected.length > 0) {
    const cardLinks = page.locator('a[href*="selected="]');
    const linkCount = Math.min(await cardLinks.count(), 5);
    for (let i = 0; i < linkCount; i++) {
      await cardLinks.nth(i).click().catch(() => {});
      await delay(1500);
      const contact = await fetchContactFromDetailPanel(page);
      if (contact.email || contact.phone) {
        const match = collected[i];
        if (match) {
          match.email = contact.email || match.email;
          match.phone = contact.phone || match.phone;
        }
      }
      await page.keyboard.press("Escape").catch(() => {});
      await delay(500);
    }
  }

  if (collected.length === 0) {
    await logDomDiagnostics(page, `job-${jobId}`);
  }

  return collected;
}

async function scrapeJobsApplicants(page, context, network) {
  const candidates = [];

  console.log("\n📋 Scanning open job positions for applicants...");

  try {
    const jobs = await extractJobIdsFromAllSources(page, network);
    const limited = jobs.slice(0, SCRAPER_CONFIG.maxJobs);

    console.log(`  Found ${jobs.length} jobs with applicant links (processing ${limited.length})`);

    if (limited.length === 0) {
      await logDomDiagnostics(page, "jobs");
      return candidates;
    }

    for (const job of limited) {
      const label = job.title || `Job ${job.jobId}`;
      console.log(`  Scraping "${label}" (jobid=${job.jobId})...`);

      try {
        const jobCandidates = await scrapeJobCandidates(page, context, job.jobId, job.title, network);
        if (jobCandidates.length > 0) {
          console.log(`    → ${jobCandidates.length} candidates`);
          candidates.push(...jobCandidates);
        } else {
          console.log("    → 0 candidates on page");
        }
      } catch (err) {
        console.warn(`    Warning: job ${job.jobId} failed: ${err.message}`);
      }

      await delay(SCRAPER_CONFIG.delayMs);
    }
  } catch (err) {
    console.warn("  Warning: Could not scrape job applicants:", err.message);
  }

  return candidates;
}

/** Convert SEEK relative strings ("3 hours ago", "6 months ago") to a Date */
function parseRelativeAppliedAtToDate(relative) {
  const now = new Date();
  if (!relative) return now;

  const s = String(relative).toLowerCase().trim();
  if (s === "today") return now;
  if (s === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }

  const m = s.match(
    /(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago|(\d+)\s*(minutes?|hours?|days?|weeks?|months?|years?)\s*ago/i,
  );
  if (m) {
    const n = parseInt(m[1] || m[3], 10);
    const unit = (m[2] || m[4] || "").toLowerCase();
    const d = new Date(now);
    if (unit.startsWith("minute")) d.setMinutes(d.getMinutes() - n);
    else if (unit.startsWith("hour")) d.setHours(d.getHours() - n);
    else if (unit.startsWith("day")) d.setDate(d.getDate() - n);
    else if (unit.startsWith("week")) d.setDate(d.getDate() - n * 7);
    else if (unit.startsWith("month")) d.setMonth(d.getMonth() - n);
    else if (unit.startsWith("year")) d.setFullYear(d.getFullYear() - n);
    return d;
  }

  const parsed = new Date(relative);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return now;
}

function parseRelativeAppliedAtToIso(relative) {
  return parseRelativeAppliedAtToDate(relative).toISOString();
}

function isWithinMaxAgeMonths(appliedAtLabel, maxAgeMonths) {
  if (!maxAgeMonths || maxAgeMonths <= 0) return true;
  const applied = parseRelativeAppliedAtToDate(appliedAtLabel);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - maxAgeMonths);
  return applied >= cutoff;
}

function loadScrapeCheckpoint(customPath) {
  const p = customPath || CHECKPOINT_PATH;
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function hasResumeOnDisk(c) {
  return Boolean(c.resumeLocalPath && fs.existsSync(c.resumeLocalPath));
}

/** ATS needs: email, phone (list), domicile, resume file */
function needsProfileEnrich(c) {
  return (
    !c.email ||
    !c.location ||
    !c.domicile ||
    !hasResumeOnDisk(c)
  );
}

function drainNetworkCandidatesInto(network, candidate) {
  while (network.candidates.length > 0) {
    const row = network.candidates.shift();
    mergeApiFieldsIntoCandidate(candidate, row);
  }
}

async function attachNetworkSniffer(page, network) {
  page.on("response", network.onResponse);
}

function saveScrapeCheckpoint(candidates, lastPage) {
  if (!SCRAPER_CONFIG.saveCheckpoint) return;
  fs.writeFileSync(
    CHECKPOINT_PATH,
    JSON.stringify(
      {
        lastPage,
        maxAgeMonths: SCRAPER_CONFIG.maxAgeMonths,
        candidateCount: candidates.length,
        savedAt: new Date().toISOString(),
        candidates,
      },
      null,
      2,
    ),
  );
}

function guessResumeMimeType(fileName) {
  const lower = (fileName || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".doc")) return "application/msword";
  return "application/pdf";
}

/** Vercel serverless body limit ~4.5MB — stay under 2.5MB per request to be safe. */
const VERCEL_IMPORT_MAX_BYTES = parseInt(
  process.env.IMPORT_BATCH_MAX_BYTES || "2500000",
  10,
);
const VERCEL_SINGLE_CANDIDATE_MAX_BYTES = parseInt(
  process.env.IMPORT_SINGLE_MAX_BYTES || "4200000",
  10,
);

function buildImportBatches(apiCandidates) {
  const batches = [];
  let current = [];
  let currentBytes = 2;

  for (const candidate of apiCandidates) {
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    const wouldExceed =
      current.length > 0 && currentBytes + candidateBytes > VERCEL_IMPORT_MAX_BYTES;

    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }

    current.push(candidate);
    currentBytes += candidateBytes;
  }

  if (current.length > 0) batches.push(current);
  return batches.length > 0 ? batches : [[]];
}

async function postCandidateBatch(batch) {
  const response = await fetch(SCRAPER_CONFIG.nuanuApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SCRAPER_CONFIG.nuanuApiKey,
    },
    body: JSON.stringify({ candidates: batch }),
    signal: AbortSignal.timeout(batch.some((c) => c.resumeBase64) ? 180000 : 120000),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`API returned ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

function payloadByteSize(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/** Attach base64 resume from local downloads/ for API upload to Supabase */
function buildApiCandidatePayload(c, { includeResume = true } = {}) {
  const payload = {
    name: c.name,
    email: c.email,
    phone: c.phone,
    appliedRole: c.appliedRole,
    mostRecentRole: c.mostRecentRole,
    seekStatus: c.seekStatus,
    appliedAt: parseRelativeAppliedAtToIso(c.appliedAt),
    profileUrl: c.profileUrl,
    source: c.source,
    location: c.location || null,
    domicile: c.domicile || c.location || null,
  };

  if (includeResume && c.resumeLocalPath && fs.existsSync(c.resumeLocalPath)) {
    const buf = fs.readFileSync(c.resumeLocalPath);
    const trial = {
      ...payload,
      resumeBase64: buf.toString("base64"),
      resumeFileName: path.basename(c.resumeLocalPath),
      resumeMimeType: guessResumeMimeType(path.basename(c.resumeLocalPath)),
    };
    if (payloadByteSize(trial) <= VERCEL_SINGLE_CANDIDATE_MAX_BYTES) {
      Object.assign(payload, {
        resumeBase64: trial.resumeBase64,
        resumeFileName: trial.resumeFileName,
        resumeMimeType: trial.resumeMimeType,
      });
    }
  }

  return payload;
}

async function postCandidateBatchWith413Fallback(batch) {
  try {
    return await postCandidateBatch(batch);
  } catch (err) {
    if (err.status !== 413) throw err;

    if (batch.length > 1) {
      console.log(`  ⚠️  Batch too large — retrying ${batch.length} candidates one-by-one…`);
      const merged = { results: { imported: 0, skipped: 0, errors: 0, details: [] } };
      for (const single of batch) {
        try {
          const one = await postCandidateBatchWith413Fallback([single]);
          merged.results.imported += one.results?.imported || 0;
          merged.results.skipped += one.results?.skipped || 0;
          merged.results.errors += one.results?.errors || 0;
          if (Array.isArray(one.results?.details)) {
            merged.results.details.push(...one.results.details);
          }
        } catch (singleErr) {
          merged.results.errors += 1;
          merged.results.details.push(
            `ERROR: ${single.name || "Unknown"} — ${singleErr.message}`,
          );
        }
        await delay(500);
      }
      return merged;
    }

    const only = batch[0];
    if (only?.resumeBase64) {
      console.log(
        `  ⚠️  CV too large for ${only.name || "candidate"} — importing without resume in payload`,
      );
      const slim = { ...only };
      delete slim.resumeBase64;
      delete slim.resumeFileName;
      delete slim.resumeMimeType;
      return await postCandidateBatch([slim]);
    }

    throw err;
  }
}

async function sendToNuanuATS(candidates) {
  if (candidates.length === 0) {
    console.log("⚠️  No candidates to send");
    return;
  }

  const withResume = candidates.filter(
    (c) => c.resumeLocalPath && fs.existsSync(c.resumeLocalPath),
  ).length;
  console.log(`\n📤 Sending ${candidates.length} candidates to Nuanu ATS...`);
  if (withResume > 0) {
    console.log(`  📎 Including ${withResume} resume file(s) for Supabase upload`);
  }

  const apiCandidates = candidates.map(buildApiCandidatePayload);
  const batches = buildImportBatches(apiCandidates);

  let totalImported = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  Sending batch ${i + 1}/${batches.length} (${batch.length} candidates)...`);

    try {
      const result = await postCandidateBatchWith413Fallback(batch);
      console.log(
        `  ✅ Batch ${i + 1}: ${result.results?.imported ?? 0} imported, ${result.results?.skipped ?? 0} skipped, ${result.results?.errors ?? 0} errors`,
      );

      const details = result.results?.details;
      if (Array.isArray(details)) {
        for (const line of details.slice(0, 8)) {
          console.log(`      ${line}`);
        }
        if (details.length > 8) {
          console.log(`      … and ${details.length - 8} more`);
        }
      }

      totalImported += result.results?.imported || 0;
      totalSkipped += result.results?.skipped || 0;
      totalErrors += result.results?.errors || 0;
    } catch (err) {
      console.error(`  ❌ Batch ${i + 1} failed:`, err.message);
      totalErrors += batch.length;
    }

    await delay(1000);
  }

  console.log("\n📊 IMPORT SUMMARY:");
  console.log(`  ✅ Imported:  ${totalImported}`);
  console.log(`  ⏭️  Skipped:   ${totalSkipped}`);
  console.log(`  ❌ Errors:    ${totalErrors}`);
  console.log("\n🎉 Done! Check your dashboard:");
  console.log("   https://nuanu-hr-recruitment-ats.vercel.app/dashboard/candidates");
}

function logCandidateNames(candidates) {
  const names = candidates.map((c) => c.name).filter(Boolean);
  const preview = names.slice(0, 30);
  console.log(`\n📋 Candidate names (${names.length} total, showing up to 30):`);
  for (const n of preview) {
    console.log(`  - ${n}`);
  }
  if (names.length > 30) {
    console.log(`  ... and ${names.length - 30} more`);
  }
}

async function main() {
  if (SCRAPER_CONFIG.turboEnrich) {
    const cpPath = SCRAPER_CONFIG.turboEnrichCheckpoint;
    console.log("⚡ PHASE 2 — Enrich checkpoint (email, location, resume)");
    console.log(`  Checkpoint: ${cpPath}`);
    const cp = loadScrapeCheckpoint(cpPath);
    if (!cp?.candidates?.length) {
      console.error("❌ No candidates in checkpoint. Run phase 1 first (npm run turbo-list).");
      process.exit(1);
    }
    const allCands = cp.candidates;
    const need = allCands.filter(needsProfileEnrich);
    console.log(
      `  Total: ${allCands.length} | need enrich: ${need.length} (missing email, location, or resume)`,
    );

    const context = await launchSeekBrowser({ headless: SCRAPER_CONFIG.headless });
    const network = createNetworkCollector();
    try {
      await ensureSeekSession(context);
      const enriched = await enrichCheckpointCandidates(context, allCands, network);
      console.log(`  ✅ Enriched ${enriched} profiles`);

      const stillNeed = allCands.filter((c) => !c.email);
      if (stillNeed.length > 0) {
        const page = await context.newPage();
        await attachNetworkSniffer(page, network);
        console.log(`\n--- Job pipeline fallback (${stillNeed.length} without email) ---`);
        await enrichCandidatesViaJobPipelines(page, context, allCands, network);
        await page.close().catch(() => {});
      }

      saveScrapeCheckpoint(allCands, cp.lastPage || 0);
      const deduped = dedupeCandidates(allCands);
      if (!SCRAPER_CONFIG.scrapeOnly) {
        await sendToNuanuATS(deduped);
      } else {
        console.log(`\n✅ Done. ${deduped.length} candidates in checkpoint (SCRAPE_ONLY).`);
      }
    } finally {
      await context.close();
    }
    return;
  }

  console.log("🚀 SEEK → Nuanu ATS Scraper Starting...");
  if (TURBO_MODE) {
    console.log("⚡ TURBO MODE — Phase 1 list fast; then run: npm run turbo-enrich");
  }
  console.log("=========================================");
  console.log(`  SEEK Email:  ${CONFIG.seekEmail || "(not set)"}`);
  logPasswordDiagnostics();
  if (!SCRAPER_CONFIG.scrapeOnly) {
    console.log(`  Nuanu URL:   ${SCRAPER_CONFIG.nuanuApiUrl}`);
  } else {
    console.log("  Mode:        SCRAPE_ONLY (no API POST)");
  }
  console.log(`  Headless:    ${SCRAPER_CONFIG.headless}`);
  console.log(`  Delays:      list=${SCRAPER_CONFIG.listSettleMs}ms profile=${SCRAPER_CONFIG.profileSettleMs}ms between=${SCRAPER_CONFIG.delayMs}ms`);
  console.log(`  Pages:       ${SCRAPER_CONFIG.startPage} → ${SCRAPER_CONFIG.maxPages}`);
  console.log(
    `  Max age:     ${SCRAPER_CONFIG.maxAgeMonths > 0 ? `${SCRAPER_CONFIG.maxAgeMonths} months` : "off (all pages)"}`,
  );
  console.log(`  Max Jobs:    ${SCRAPER_CONFIG.maxJobs}`);
  if (SCRAPER_CONFIG.saveCheckpoint) {
    console.log(`  Checkpoint:  ${CHECKPOINT_PATH}`);
  }
  console.log(
    `  Profiles:    ${SCRAPER_CONFIG.fetchContactDetails ? "email + resume per candidate" : "⚡ list only"}`,
  );
  if (SCRAPER_CONFIG.fetchContactDetails) {
    console.log(`  Resumes →   ${DOWNLOADS_DIR}`);
  }
  console.log("=========================================\n");

  let context = await launchSeekBrowser({ headless: SCRAPER_CONFIG.headless });
  let page;

  const network = createNetworkCollector();

  let allCandidates = [];

  try {
    if (SCRAPER_CONFIG.headless) {
      console.log("\n⚠️  HEADLESS=true — if not logged in, run: npm run login");
      try {
        page = await ensureSeekSession(context);
      } catch (sessionErr) {
        console.log("  Retrying with visible browser…");
        await context.close().catch(() => {});
        context = await launchSeekBrowser({ headless: false });
        page = await ensureSeekSession(context);
      }
    } else {
      page = await ensureSeekSession(context);
    }

    await attachNetworkSniffer(page, network);

    console.log("\n--- Your Candidates (Past applicants) ---");
    const candidatesPageResults = await scrapeCandidatesPage(page, context, network);
    allCandidates.push(...candidatesPageResults);

    if (SCRAPER_CONFIG.fetchContactDetails) {
      const needEmail = () => allCandidates.filter((c) => !c.email).length;
      if (needEmail() > 0) {
        console.log(`\n--- Enriching via job pipelines (${needEmail()} without email) ---`);
        const jobEnriched = await enrichCandidatesViaJobPipelines(
          page,
          context,
          allCandidates,
          network,
        );
        console.log(`  📇 Job pipeline enrichment: ${jobEnriched} emails captured`);
      }
    }

    if (SCRAPER_CONFIG.scrapeJobs) {
      console.log("\n--- Scraping Job Applicants (SCRAPE_JOBS=true) ---");
      const jobApplicants = await scrapeJobsApplicants(page, context, network);
      allCandidates.push(...jobApplicants);
    }

    allCandidates = dedupeCandidates(allCandidates);

    console.log(`\n📊 Total unique candidates scraped: ${allCandidates.length}`);
    logCandidateNames(allCandidates);

    if (SCRAPER_CONFIG.scrapeOnly) {
      console.log("\n✅ Scrape complete (SCRAPE_ONLY=true, skipped API import)");
    } else {
      await sendToNuanuATS(allCandidates);
    }
  } catch (err) {
    console.error("\n❌ Fatal error:", err.message);
    console.error(`   Current URL: ${page?.url?.() ?? "(no page)"}`);
    const screenshotPath = path.join(__dirname, "debug-screenshot.png");
    await page?.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`📸 Debug screenshot saved: ${screenshotPath}`);
    console.log("   Tip: run `npm run login` to sign in manually and save seek-auth.json");
    process.exit(1);
  } finally {
    await context.close();
  }
}

main().catch(console.error);
