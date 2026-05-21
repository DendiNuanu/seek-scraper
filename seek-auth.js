import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUTH_STATE_PATH = path.join(__dirname, "seek-auth.json");
export const SESSION_STORAGE_PATH = path.join(__dirname, "seek-session-storage.json");
export const BROWSER_PROFILE_DIR = path.join(__dirname, ".seek-browser-profile");

export const CONFIG = {
  seekEmail: process.env.SEEK_EMAIL,
  seekPassword: process.env.SEEK_PASSWORD,
  headless: process.env.HEADLESS === "true",
};

export const SEEK = {
  employerHome: "https://id.employer.seek.com/",
  dashboard: "https://id.employer.seek.com/dashboard",
  oauthLogin: "https://id.employer.seek.com/oauth/login",
  yourCandidates: "https://id.employer.seek.com/your-candidates",
  yourCandidatesPage: (pageNum) =>
    pageNum <= 1
      ? "https://id.employer.seek.com/your-candidates"
      : `https://id.employer.seek.com/your-candidates?page=${pageNum}`,
  jobs: "https://id.employer.seek.com/jobs",
  candidatesForJob: (jobId) =>
    `https://id.employer.seek.com/candidates?jobid=${jobId}`,
};

export const LOGIN_SELECTORS = {
  email: "#emailAddress, input[name='emailAddress_hirer']",
  password: "#password, input[name='password_hirer']",
};

const SEEK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
];

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function logPasswordDiagnostics() {
  console.log("  Auth mode:    manual sign-in (npm run login)");
  if (CONFIG.headless) {
    console.warn("  ⚠️  HEADLESS=true — set HEADLESS=false in .env for reliable SEEK login");
  }
}

export function hasBrowserProfile() {
  return fs.existsSync(BROWSER_PROFILE_DIR);
}

function assertPageOpen(page) {
  if (page.isClosed()) {
    throw new Error(
      "Browser window was closed. Keep the Chromium window open until the script finishes.",
    );
  }
}

/** Navigate without crashing on OAuth redirects (ERR_ABORTED). */
export async function safeGoto(page, url) {
  assertPageOpen(page);

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await delay(1500);
      return;
    } catch (err) {
      assertPageOpen(page);
      const msg = err.message || "";
      if (attempt < 4 && /ERR_ABORTED|NS_BINDING_ABORTED|interrupted/i.test(msg)) {
        console.log(`  Navigation interrupted (attempt ${attempt}/4), retrying...`);
        await delay(2000);
        continue;
      }
      throw err;
    }
  }
}

export async function isOnSeekSignInPage(page) {
  const url = page.url();
  if (url.includes("authenticate.seek.com")) return true;
  if (url.includes("/oauth/login")) return true;
  return page
    .locator(LOGIN_SELECTORS.email)
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
}

export async function isYourCandidatesReady(page) {
  assertPageOpen(page);

  if (await isOnSeekSignInPage(page)) return false;

  const url = page.url();
  if (!url.includes("employer.seek.com")) return false;

  return page
    .getByText(/Search all your applicants/i)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

export async function restoreSessionStorage(context) {
  if (!fs.existsSync(SESSION_STORAGE_PATH)) return false;
  try {
    const items = JSON.parse(fs.readFileSync(SESSION_STORAGE_PATH, "utf8"));
    await context.addInitScript((storage) => {
      for (const [key, value] of Object.entries(storage)) {
        try {
          sessionStorage.setItem(key, value);
        } catch {
          // ignore
        }
      }
    }, items);
    return true;
  } catch {
    return false;
  }
}

export async function saveSessionStorage(page) {
  assertPageOpen(page);

  const items = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) out[key] = sessionStorage.getItem(key);
    }
    return out;
  });

  if (Object.keys(items).length === 0) return;

  fs.writeFileSync(SESSION_STORAGE_PATH, JSON.stringify(items, null, 2));
  console.log(`💾 sessionStorage saved (${Object.keys(items).length} keys)`);
}

export async function launchSeekBrowser(options = {}) {
  const headless = options.headless ?? CONFIG.headless;
  fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });

  const downloadsPath = path.join(__dirname, "downloads");
  fs.mkdirSync(downloadsPath, { recursive: true });

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    userAgent: SEEK_USER_AGENT,
    viewport: { width: 1400, height: 900 },
    locale: "en-ID",
    timezoneId: "Asia/Jakarta",
    args: CHROMIUM_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
    acceptDownloads: true,
    downloadsPath,
  });

  context.on("close", () => {
    console.log("  (browser context closed)");
  });

  await restoreSessionStorage(context);

  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return context;
}

export function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Do NOT navigate while the user signs in — only poll the current page.
 */
export async function waitForManualLogin(page, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;

  console.log("\n👤 Sign in to SEEK in the browser window.");
  console.log("   Open the Past applicants tab if needed.");
  console.log("   When the candidate table is visible, press ENTER in this terminal.\n");

  await waitForEnter("   Press ENTER when you see the applicants table… ");

  while (Date.now() < deadline) {
    assertPageOpen(page);

    if (await isYourCandidatesReady(page)) {
      console.log("✅ Applicants page detected");
      return;
    }

    console.log("  Still waiting for applicants table… (current URL:", page.url(), ")");
    await delay(3000);
  }

  throw new Error("Timed out — open your-candidates and press ENTER when the table loads.");
}

export async function saveSession(context) {
  await context.storageState({ path: AUTH_STATE_PATH });
}

export async function persistAuthState(context, page) {
  assertPageOpen(page);
  await saveSession(context);
  await saveSessionStorage(page);
}

export async function openYourCandidates(page) {
  await safeGoto(page, SEEK.yourCandidates);

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
      await delay(2000);
    }
  }
}

/**
 * Manual login only — automated Auth0 fails when SEEK shows captcha or password issues.
 */
export async function ensureSeekSession(context) {
  const page = context.pages()[0] || (await context.newPage());

  console.log("📂 Opening Your Candidates…");
  await openYourCandidates(page);

  if (await isYourCandidatesReady(page)) {
    console.log("✅ Already signed in");
    await persistAuthState(context, page);
    return page;
  }

  if (CONFIG.headless) {
    throw new Error(
      "Not signed in to SEEK.\n" +
        "  Run:  npm run login\n" +
        "  Then: npm run dry-run\n" +
        "Set HEADLESS=false in .env — SEEK requires a visible browser to sign in.",
    );
  }

  await waitForManualLogin(page);
  await persistAuthState(context, page);

  if (!(await isYourCandidatesReady(page))) {
    await openYourCandidates(page);
  }

  if (!(await isYourCandidatesReady(page))) {
    throw new Error("Could not load Your Candidates after sign-in.");
  }

  console.log("✅ Ready to scrape");
  return page;
}

export async function ensureStillLoggedIn(context, page) {
  assertPageOpen(page);

  if (page.url().includes("authenticate.seek.com") || (await isOnSeekSignInPage(page))) {
    console.log("  ↻ Sign-in required again…");
    return ensureSeekSession(context);
  }
  return page;
}
