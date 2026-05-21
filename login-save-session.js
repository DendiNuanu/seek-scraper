import {
  launchSeekBrowser,
  safeGoto,
  SEEK,
  persistAuthState,
  waitForManualLogin,
  openYourCandidates,
  isYourCandidatesReady,
  BROWSER_PROFILE_DIR,
} from "./seek-auth.js";

async function main() {
  console.log("🔐 SEEK login — save session for scraper");
  console.log("========================================");
  console.log(`  Profile: ${BROWSER_PROFILE_DIR}`);
  console.log("  Target:  https://id.employer.seek.com/your-candidates\n");

  const context = await launchSeekBrowser({ headless: false });
  const page = context.pages()[0] || (await context.newPage());

  try {
    await safeGoto(page, SEEK.yourCandidates);

    if (!(await isYourCandidatesReady(page))) {
      await waitForManualLogin(page);
    } else {
      console.log("✅ Already on Your Candidates — saving session…");
    }

    await openYourCandidates(page);
    await persistAuthState(context, page);

    console.log("\n✅ Session saved. Run:  npm run dry-run   or   npm start");
  } catch (err) {
    console.error("\n❌ Login failed:", err.message);
    process.exit(1);
  } finally {
    if (!page.isClosed()) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
