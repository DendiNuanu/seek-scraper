import "dotenv/config";
import {
  SEEK,
  delay,
  ensureSeekSession,
  launchSeekBrowser,
} from "./seek-auth.js";

async function domSample(page, label) {
  return page.evaluate((lbl) => {
    const sample = {
      label: lbl,
      url: location.href,
      title: document.title,
      trCount: document.querySelectorAll("table tbody tr").length,
      tableCount: document.querySelectorAll("table").length,
      articleCount: document.querySelectorAll("article").length,
      linkCandidate: document.querySelectorAll('a[href*="candidate"]').length,
      dataAutomation: [...document.querySelectorAll("[data-automation]")]
        .slice(0, 30)
        .map((el) => ({
          attr: el.getAttribute("data-automation"),
          tag: el.tagName,
          text: (el.textContent || "").trim().slice(0, 80),
        })),
      buttons: [...document.querySelectorAll("button, [role=tab]")]
        .slice(0, 20)
        .map((el) => (el.textContent || "").trim().slice(0, 60)),
      bodySnippet: document.body?.innerText?.slice(0, 1500),
    };
    return sample;
  }, label);
}

async function main() {
  const headless = process.env.HEADLESS === "true";
  const context = await launchSeekBrowser({ headless });
  const page = await ensureSeekSession(context);

  try {

    await page.goto(SEEK.yourCandidates, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
    await delay(4000);
    console.log("\n=== your-candidates (initial) ===");
    console.log(JSON.stringify(await domSample(page, "your-candidates"), null, 2));

    const pastTab = page.locator('button, [role="tab"]').filter({ hasText: /Past applicants/i }).first();
    if (await pastTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await pastTab.click();
      await delay(3000);
      console.log("\n=== your-candidates (Past applicants tab) ===");
      console.log(JSON.stringify(await domSample(page, "past-applicants"), null, 2));
    }

    await page.goto(SEEK.dashboard, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(3000);
    console.log("\n=== dashboard ===");
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          jobLinks: [...document.querySelectorAll('a[href*="jobid"], a[href*="jobId"]')]
            .map((a) => a.href)
            .slice(0, 10),
        })),
        null,
        2,
      ),
    );

    await page.goto(SEEK.jobs, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(3000);
    console.log("\n=== jobs ===");
    const jobsSample = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href]")]
        .map((a) => a.href)
        .filter((h) => /candidates|jobid|jobId|applicant/i.test(h));
      return { candidateLinks: [...new Set(links)].slice(0, 15) };
    });
    console.log(JSON.stringify(jobsSample, null, 2));

    const firstJobId = jobsSample.candidateLinks
      ?.map((u) => {
        const m = u.match(/[?&]jobid=(\d+)|[?&]jobId=(\d+)/i);
        return m ? m[1] || m[2] : null;
      })
      .find(Boolean);

    if (firstJobId) {
      const url = `https://id.employer.seek.com/candidates?jobid=${firstJobId}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await delay(4000);
      console.log(`\n=== candidates job ${firstJobId} ===`);
      console.log(JSON.stringify(await domSample(page, `job-${firstJobId}`), null, 2));
    }
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
