/**
 * diagnose-dom.js
 *
 * Dumps the actual DOM structure of the SEEK candidate profile panel
 * so we can see how career history, education, licences sections are
 * structured and fix the extractors in seek-extract.js accordingly.
 *
 * Usage: HEADLESS=true node diagnose-dom.js
 *        HEADLESS=false node diagnose-dom.js   (visible browser)
 */
import "dotenv/config";
import {
  delay,
  ensureSeekSession,
  ensureStillLoggedIn,
  launchSeekBrowser,
  logPasswordDiagnostics,
} from "./seek-auth.js";
import { SCRAPER_CONFIG, expandSeekProfileSections, withProfileTab } from "./scraper.js";

const JOB_ID = "92574415";
const SELECTED_ID = "796b6454-188b-4dd8-8bf8-932d7a5d29e5";
const PROFILE_URL = `https://id.employer.seek.com/candidates?jobid=${JOB_ID}&selected=${SELECTED_ID}`;
const HEADLESS = process.env.HEADLESS === "true";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SEEK DOM Diagnostic Dump");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Profile: ${PROFILE_URL}`);
  console.log(`  Headless: ${HEADLESS}`);
  console.log("───────────────────────────────────────────────────────────────\n");

  logPasswordDiagnostics();

  const context = await launchSeekBrowser({ headless: HEADLESS });

  try {
    console.log("[1/4] Ensuring SEEK session…");
    const page = await ensureSeekSession(context);
    await ensureStillLoggedIn(context, page);
    console.log("      ✅ Session ready.\n");

    console.log("[2/4] Navigating to profile tab…");
    const profileTabUrl = withProfileTab(PROFILE_URL);
    try {
      await page.goto(profileTabUrl, { waitUntil: "networkidle", timeout: 30000 });
    } catch {
      await page.goto(profileTabUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    console.log("[3/4] Waiting for profile sections + expanding 'More' toggles…");
    await page.waitForFunction(() => {
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong"));
      return headings.some((h) => {
        const t = h.textContent.trim();
        return t === "Career history" || t === "Education" || t === "Skills";
      });
    }, { timeout: 20000 }).catch(() => {
      console.log("      ⚠️ Profile sections not found within timeout.");
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

    const clicked = await expandSeekProfileSections(page);
    console.log(`      Expanded ${clicked} "More" toggle(s).\n`);

    console.log("[4/4] Dumping DOM structure of each section…\n");

    // ── Dump the outerHTML of each section container ──────────────────────
    const dump = await page.evaluate(() => {
      const result = { sections: {}, rawHeadings: [] };

      // Collect all heading-like elements to see what's on the page.
      const allHeadings = Array.from(
        document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,[role='heading']")
      );
      result.rawHeadings = allHeadings.map((h) => ({
        tag: h.tagName.toLowerCase(),
        text: (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        class: (h.className || "").toString().slice(0, 80),
      }));

      // For each target section, find the heading and dump its container's HTML.
      const sectionLabels = {
        careerHistory: ["career history", "riwayat pekerjaan"],
        education: ["education", "pendidikan"],
        licences: ["licences", "licenses", "licences and certifications", "sertifikasi"],
        applicationQuestions: ["application questions", "pertanyaan penyaringan"],
        skills: ["skills", "keahlian"],
      };

      function findHeading(labels) {
        const candidates = Array.from(
          document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,[role='heading']")
        );
        for (const h of candidates) {
          const text = (h.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (labels.includes(text)) return h;
        }
        // Fuzzy: startsWith
        for (const h of candidates) {
          const text = (h.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (labels.some((l) => text.startsWith(l))) return h;
        }
        return null;
      }

      function getContainer(heading) {
        if (!heading) return null;
        let container = heading.parentElement;
        for (let d = 0; d < 8 && container && container !== document.body; d++) {
          // A good container has multiple child blocks (entries).
          const children = container.querySelectorAll("div, section, article, li, [role='listitem']");
          if (children.length >= 2) break;
          container = container.parentElement;
        }
        return container || heading.parentElement;
      }

      for (const [key, labels] of Object.entries(sectionLabels)) {
        const heading = findHeading(labels);
        if (!heading) {
          result.sections[key] = { found: false };
          continue;
        }
        const container = getContainer(heading);
        if (!container) {
          result.sections[key] = { found: true, headingText: heading.textContent.trim(), container: null };
          continue;
        }

        // Dump the container's innerText (line by line) and a snippet of outerHTML.
        const innerText = (container.innerText || "").trim();
        const lines = innerText.split("\n").map((s) => s.trim()).filter(Boolean);

        // Also dump the direct children structure (tag, class, text preview).
        const directChildren = Array.from(container.children).map((child) => ({
          tag: child.tagName.toLowerCase(),
          class: (child.className || "").toString().slice(0, 100),
          textPreview: (child.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150),
          childCount: child.children.length,
        }));

        // Truncate outerHTML to avoid huge dumps.
        let outerHTML = container.outerHTML || "";
        if (outerHTML.length > 8000) outerHTML = outerHTML.slice(0, 8000) + "\n…[TRUNCATED]…";

        result.sections[key] = {
          found: true,
          headingTag: heading.tagName.toLowerCase(),
          headingText: heading.textContent.trim(),
          headingClass: (heading.className || "").toString().slice(0, 100),
          containerTag: container.tagName.toLowerCase(),
          containerClass: (container.className || "").toString().slice(0, 100),
          lineCount: lines.length,
          lines: lines.slice(0, 60),
          directChildrenCount: directChildren.length,
          directChildren: directChildren.slice(0, 20),
          outerHTMLSnippet: outerHTML,
        };
      }

      return result;
    });

    // ── Print the dump ───────────────────────────────────────────────────
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  ALL HEADINGS ON PAGE");
    console.log("═══════════════════════════════════════════════════════════════");
    for (const h of dump.rawHeadings) {
      console.log(`  <${h.tag} class="${h.class}"> ${h.text}`);
    }

    for (const [key, info] of Object.entries(dump.sections)) {
      console.log("\n═══════════════════════════════════════════════════════════════");
      console.log(`  SECTION: ${key}`);
      console.log("═══════════════════════════════════════════════════════════════");
      if (!info.found) {
        console.log("  ❌ Heading not found.");
        continue;
      }
      console.log(`  Heading: <${info.headingTag} class="${info.headingClass}"> "${info.headingText}"`);
      if (!info.containerTag) {
        console.log("  ❌ No container found.");
        continue;
      }
      console.log(`  Container: <${info.containerTag} class="${info.containerClass}">`);
      console.log(`  Lines (${info.lineCount}):`);
      for (const line of info.lines) {
        console.log(`    | ${line.slice(0, 200)}`);
      }
      console.log(`\n  Direct children (${info.directChildrenCount}):`);
      for (const child of info.directChildren) {
        console.log(`    <${child.tag} class="${child.class}" children=${child.childCount}> ${child.textPreview.slice(0, 120)}`);
      }
      console.log(`\n  outerHTML (first 8000 chars):`);
      console.log(info.outerHTMLSnippet);
    }

    // Save full dump to file for offline analysis.
    const fs = await import("node:fs/promises");
    await fs.writeFile("diagnose-dom-output.json", JSON.stringify(dump, null, 2));
    console.log("\n💾 Full dump written to: ./diagnose-dom-output.json");
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("❌ Diagnostic failed:", err);
  process.exit(1);
});
