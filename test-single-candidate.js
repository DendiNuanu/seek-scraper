/**
 * test-single-candidate.js
 *
 * Single-candidate end-to-end test for the SEEK scraper depth improvements.
 *
 * Verifies that:
 *   1. "More⁠"/"Less⁠" toggles are clicked before extraction (full descriptions).
 *   2. All 5 profile sections are extracted with per-section try/catch + [] fallback.
 *   3. Field names are normalised to match the ATS-side parsers in
 *      lib/profile-data.ts (dates→startDate/endDate, status→yearCompleted,
 *      organization→issuingOrganisation).
 *   4. The payload built by buildApiCandidatePayload() contains every section.
 *
 * Reference candidate: Halda Purwinarto
 *   jobid=92574415, selected=796b6454-188b-4dd8-8bf8-932d7a5d29e5
 *   Expected depth: 4 jobs, 3 education, 5 licences, 6 application questions, ~15 skills
 *
 * Usage:
 *   node test-single-candidate.js              # extract + report (no POST)
 *   node test-single-candidate.js --post       # also POST to ATS and print response
 *   node test-single-candidate.js --headless   # run headless (needs saved session)
 *
 * Environment:
 *   HEADLESS=true|false  (default: false — visible browser for manual login if needed)
 */
import "dotenv/config";
import {
  CONFIG,
  SEEK,
  delay,
  ensureSeekSession,
  ensureStillLoggedIn,
  launchSeekBrowser,
  logPasswordDiagnostics,
} from "./seek-auth.js";
import { createNetworkCollector } from "./seek-extract.js";
import {
  SCRAPER_CONFIG,
  attachNetworkSniffer,
  buildApiCandidatePayload,
  captureProfileDetails,
  expandSeekProfileSections,
  normaliseSeekSectionsForAts,
  withProfileTab,
} from "./scraper.js";

// ── Reference candidate ─────────────────────────────────────────────────────
const JOB_ID = "92574415";
const SELECTED_ID = "796b6454-188b-4dd8-8bf8-932d7a5d29e5";
const CANDIDATE_NAME = "Halda Purwinarto";
const PROFILE_URL = `https://id.employer.seek.com/candidates?jobid=${JOB_ID}&selected=${SELECTED_ID}`;

// Expected section depths (from the reference data the user provided).
const EXPECTED = {
  careerHistory: 4,
  education: 3,
  licencesAndCertifications: 5,
  applicationQuestions: 6,
  skills: 15,
};

const args = new Set(process.argv.slice(2));
const DO_POST = args.has("--post");
const HEADLESS = args.has("--headless") || process.env.HEADLESS === "true";

// ── Helpers ──────────────────────────────────────────────────────────────────
function sectionReport(name, entries) {
  const arr = Array.isArray(entries) ? entries : [];
  const expected = EXPECTED[name] ?? null;
  const status =
    expected === null
      ? "—"
      : arr.length >= expected
        ? "✅"
        : arr.length >= Math.ceil(expected * 0.8)
          ? "🟡"
          : "❌";
  console.log(`  ${status} ${name}: ${arr.length} entries${expected ? ` (expected ≥${expected})` : ""}`);
  // Show first entry's keys so we can eyeball field-name correctness.
  if (arr.length > 0 && typeof arr[0] === "object") {
    console.log(`       sample keys: ${Object.keys(arr[0]).join(", ")}`);
    console.log(`       sample[0]: ${JSON.stringify(arr[0]).slice(0, 200)}${JSON.stringify(arr[0]).length > 200 ? "…" : ""}`);
  }
}

function fieldCheck(name, entries, requiredKey, aliasKeys = []) {
  const arr = Array.isArray(entries) ? entries : [];
  const allKeys = [requiredKey, ...aliasKeys];
  let withKey = 0;
  for (const e of arr) {
    if (e && typeof e === "object" && allKeys.some((k) => e[k] != null && e[k] !== "")) {
      withKey += 1;
    }
  }
  const pct = arr.length ? Math.round((withKey / arr.length) * 100) : 0;
  const status = pct === 100 ? "✅" : pct >= 80 ? "🟡" : "❌";
  console.log(`  ${status} ${name}: ${withKey}/${arr.length} entries have ATS-readable field (${requiredKey}${aliasKeys.length ? " | " + aliasKeys.join(" | ") : ""})`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SEEK Single-Candidate Depth Test");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Candidate: ${CANDIDATE_NAME}`);
  console.log(`  Job ID:    ${JOB_ID}`);
  console.log(`  Selected:  ${SELECTED_ID}`);
  console.log(`  Profile:   ${PROFILE_URL}`);
  console.log(`  Headless:  ${HEADLESS}`);
  console.log(`  POST to ATS: ${DO_POST ? "YES" : "NO (use --post to enable)"}`);
  console.log(`  ATS URL:   ${SCRAPER_CONFIG.nuanuApiUrl || "(not set)"}`);
  console.log("───────────────────────────────────────────────────────────────\n");

  logPasswordDiagnostics();

  const context = await launchSeekBrowser({ headless: HEADLESS });
  const network = createNetworkCollector();

  try {
    console.log("\n[1/5] Ensuring SEEK session…");
    const page = await ensureSeekSession(context);
    await attachNetworkSniffer(page, network);
    await ensureStillLoggedIn(context, page);
    console.log("      ✅ Session ready.");

    // Build a candidate object mirroring what the scraper produces.
    const candidate = {
      name: CANDIDATE_NAME,
      email: null,
      phone: null,
      appliedRole: null,
      mostRecentRole: null,
      seekStatus: null,
      appliedAt: null,
      profileUrl: PROFILE_URL,
      source: "seek-employer",
      location: null,
      domicile: null,
      seekProfileId: SELECTED_ID,
      expectedSalaryRaw: null,
      salaryExpectation: null,
      careerHistory: [],
      education: [],
      licencesAndCertifications: [],
      applicationQuestions: [],
      skills: [],
    };

    console.log("\n[2/5] Navigating to profile tab…");
    const profileTabUrl = withProfileTab(PROFILE_URL);
    try {
      await page.goto(profileTabUrl, { waitUntil: "networkidle", timeout: 30000 });
    } catch {
      await page.goto(profileTabUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    // Wait for profile sections to render (same logic as enrichFromProfileUrl).
    console.log("\n[3/5] Waiting for profile sections to render…");
    await page.waitForFunction(() => {
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong"));
      const hasCareer = headings.some((h) => {
        const t = h.textContent.trim();
        return t === "Career history" || t === "Education" || t === "Skills";
      });
      const hasAppQ = headings.some((h) => h.textContent.trim() === "Application questions");
      return hasCareer || hasAppQ;
    }, { timeout: 20000 }).catch(() => {
      console.log("      ⚠️ Profile sections not found within timeout — extracting anyway.");
    });

    // Scroll the panel so SEEK lazy-renders all sections.
    await page.evaluate(async () => {
      const panel =
        document.querySelector("aside") ||
        document.querySelector('[role="dialog"]') ||
        document.querySelector('[class*="Panel"]') ||
        document.querySelector('[class*="panel"]') ||
        document.body;
      const maxScroll = Math.max(panel.scrollHeight, document.body.scrollHeight, 2000);
      for (let y = 0; y <= maxScroll; y += 400) {
        panel.scrollTop = y;
        await new Promise((r) => setTimeout(r, 80));
      }
      panel.scrollTop = maxScroll;
      await new Promise((r) => setTimeout(r, 350));
    }).catch(() => {});

    console.log("\n[4/5] Expanding 'More⁠' toggles + extracting sections…");
    // captureProfileDetails() now calls expandSeekProfileSections() internally
    // before running the 5 section extractors. We call it directly here so the
    // test exercises the exact same code path as production.
    const ok = await captureProfileDetails(page, candidate, network);
    console.log(`      captureProfileDetails returned: ${ok ? "true" : "false"}`);

    // ── Depth report ───────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  DEPTH REPORT");
    console.log("═══════════════════════════════════════════════════════════════");
    sectionReport("careerHistory", candidate.careerHistory);
    sectionReport("education", candidate.education);
    sectionReport("licencesAndCertifications", candidate.licencesAndCertifications);
    sectionReport("applicationQuestions", candidate.applicationQuestions);
    sectionReport("skills", candidate.skills);

    console.log("\n───────────────────────────────────────────────────────────────");
    console.log("  FIELD-NAME COMPATIBILITY (ATS-side parser readability)");
    console.log("───────────────────────────────────────────────────────────────");
    // ATS parseSeekCareerHistory reads: roleTitle|title|role, organisation|company|employer, startDate, endDate
    fieldCheck("careerHistory.role", candidate.careerHistory, "title", ["roleTitle", "role"]);
    fieldCheck("careerHistory.company", candidate.careerHistory, "company", ["organisation", "employer"]);
    fieldCheck("careerHistory.startDate", candidate.careerHistory, "startDate");
    fieldCheck("careerHistory.endDate", candidate.careerHistory, "endDate");
    // ATS parseSeekEducation reads: qualification|degree|course, institution|organisation|school, yearCompleted
    fieldCheck("education.degree", candidate.education, "degree", ["qualification", "course"]);
    fieldCheck("education.institution", candidate.education, "institution", ["organisation", "school"]);
    fieldCheck("education.yearCompleted", candidate.education, "yearCompleted");
    // ATS parseSeekLicences reads: name|title|licenceName, issuingOrganisation|issuingBody|organisation|issuer
    fieldCheck("licences.name", candidate.licencesAndCertifications, "name", ["title", "licenceName"]);
    fieldCheck("licences.issuingOrganisation", candidate.licencesAndCertifications, "issuingOrganisation", ["issuingBody", "organisation", "issuer"]);
    // ATS parseSeekApplicationQuestions reads: question|label|fieldName, answer|value|response
    fieldCheck("appQuestions.question", candidate.applicationQuestions, "question", ["label", "fieldName"]);
    fieldCheck("appQuestions.answer", candidate.applicationQuestions, "answer", ["value", "response"]);

    // ── Normalise + build payload ──────────────────────────────────────────
    console.log("\n───────────────────────────────────────────────────────────────");
    console.log("  PAYLOAD BUILD (normaliseSeekSectionsForAts + buildApiCandidatePayload)");
    console.log("───────────────────────────────────────────────────────────────");
    normaliseSeekSectionsForAts(candidate);
    const payload = buildApiCandidatePayload(candidate, { includeResume: false });

    console.log("  Payload top-level keys:", Object.keys(payload).join(", "));
    console.log("  seekProfileId:", payload.seekProfileId);
    console.log("  careerHistory[0] (normalised):", JSON.stringify(payload.careerHistory[0] || {}));
    console.log("  education[0] (normalised):", JSON.stringify(payload.education[0] || {}));
    console.log("  licencesAndCertifications[0] (normalised):", JSON.stringify(payload.licencesAndCertifications[0] || {}));

    // ── Optional POST to ATS ───────────────────────────────────────────────
    if (DO_POST) {
      console.log("\n═══════════════════════════════════════════════════════════════");
      console.log("  POSTING TO ATS");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log(`  Endpoint: ${SCRAPER_CONFIG.nuanuApiUrl}`);
      const body = JSON.stringify({ candidates: [payload] });
      console.log(`  Body size: ${body.length} bytes`);

      const res = await fetch(SCRAPER_CONFIG.nuanuApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": SCRAPER_CONFIG.nuanuApiKey,
        },
        body,
      });
      const text = await res.text();
      console.log(`  HTTP ${res.status} ${res.statusText}`);
      console.log(`  Response: ${text.slice(0, 1000)}${text.length > 1000 ? "…" : ""}`);

      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (json) {
        console.log("\n  Parsed response:");
        console.log("    imported:", json.results?.imported ?? json.imported ?? "?");
        console.log("    skipped:", json.results?.skipped ?? json.skipped ?? "?");
        console.log("    errors:", json.results?.errors ?? json.errors ?? "?");
        if (Array.isArray(json.results?.details)) {
          console.log("    details:", json.results.details.slice(0, 5).join("; "));
        }
        console.log("\n  ✅ Verify at: https://hr.ats.new.nuanu.site/candidates");
        console.log(`     (search for: ${candidate.name})`);
      }
    } else {
      console.log("\n  ℹ️  Skipping ATS POST (run with --post to enable).");
    }

    // ── Save extracted data to disk for inspection ─────────────────────────
    const fs = await import("fs");
    const outPath = "./test-single-candidate-output.json";
    fs.writeFileSync(outPath, JSON.stringify({
      candidate,
      payload,
      expected: EXPECTED,
      actual: {
        careerHistory: candidate.careerHistory.length,
        education: candidate.education.length,
        licencesAndCertifications: candidate.licencesAndCertifications.length,
        applicationQuestions: candidate.applicationQuestions.length,
        skills: candidate.skills.length,
      },
    }, null, 2));
    console.log(`\n  💾 Full extraction written to: ${outPath}`);

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  TEST COMPLETE");
    console.log("═══════════════════════════════════════════════════════════════\n");
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
