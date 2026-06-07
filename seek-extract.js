/** DOM + JSON extraction helpers for SEEK Employer (Indonesia). */

// Used only in Node (network JSON parsing).
const STATUS_WORDS = [
  "New",
"Inbox",
"Prescreen",
"Shortlist",
"Interview",
"Offer",
"Accept",
"Not Suitable",
];

export function createNetworkCollector() {
  const jobs = new Map();
  const candidates = [];

  async function onResponse(response) {
    try {
      if (!response.ok()) return;
      const url = response.url();
      if (!/employer\.seek\.com|seek\.co/i.test(url)) return;
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;

      const body = await response.json().catch(() => null);
      if (!body) return;

      collectFromJson(body, { jobs, candidates });
    } catch {
      // ignore parse errors
    }
  }

  return { jobs, candidates, onResponse };
}

function collectFromJson(node, store, depth = 0) {
  if (!node || depth > 18) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object") {
        const c = normalizeApiCandidate(item);
        if (c) store.candidates.push(c);
        const j = normalizeApiJob(item);
        if (j) store.jobs.set(j.jobId, j);
      }
      collectFromJson(item, store, depth + 1);
    }
    return;
  }

  if (typeof node === "object") {
    const c = normalizeApiCandidate(node);
    if (c) store.candidates.push(c);
    const j = normalizeApiJob(node);
    if (j) store.jobs.set(j.jobId, j);

    for (const value of Object.values(node)) {
      collectFromJson(value, store, depth + 1);
    }
  }
}

function pickString(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeApiCandidate(obj) {
  if (!obj || typeof obj !== "object") return null;

  const first = pickString(obj, ["firstName", "first_name", "givenName"]);
  const last = pickString(obj, ["lastName", "last_name", "familyName", "surname"]);
  const combined = pickString(obj, [
    "name",
    "fullName",
    "full_name",
    "candidateName",
    "candidate_name",
    "displayName",
  ]);

  let name = combined || (first ? `${first} ${last || ""}`.trim() : null);
  if (!name || name.length < 2) return null;

  const email = pickString(obj, ["email", "emailAddress", "email_address"]);
  const phone = pickString(obj, [
    "phone",
    "mobile",
    "mobilePhone",
    "mobile_phone",
    "phoneNumber",
    "phone_number",
  ]);

  const seekStatus = pickString(obj, [
    "status",
    "applicationStatus",
    "application_status",
    "stage",
    "pipelineStage",
  ]);

  const appliedRole = pickString(obj, [
    "jobTitle",
    "job_title",
    "appliedRole",
    "applied_role",
    "positionTitle",
  ]);

  const profileUrl = pickString(obj, ["profileUrl", "profile_url", "url", "link"]);

  const location =
  pickString(obj, [
    "location",
    "domicile",
    "address",
    "suburb",
    "city",
    "state",
    "region",
    "homeLocation",
    "home_location",
  ]) || null;

  const resumeUrl =
  pickString(obj, [
    "resumeUrl",
    "resume_url",
    "cvUrl",
    "cv_url",
    "documentUrl",
    "document_url",
  ]) || null;

  const hasApplicationFields =
  email ||
  phone ||
  seekStatus ||
  appliedRole ||
  obj.applicationId ||
  obj.candidateId ||
  obj.application_id ||
  obj.appliedAt ||
  obj.applied_at ||
  obj.createdAt;

  if (!hasApplicationFields) return null;

  return {
    name: name.replace(/\s+/g, " "),
    email: email || null,
    phone: phone || null,
    seekStatus: seekStatus || "New",
    appliedRole: appliedRole || null,
    mostRecentRole: pickString(obj, ["mostRecentRole", "most_recent_role", "currentRole"]) || null,
    appliedAt: pickString(obj, ["appliedAt", "applied_at", "createdAt", "created_at"]) || new Date().toISOString(),
    profileUrl: profileUrl || null,
    location,
    domicile: location,
    resumeUrl,
    source: "SEEK",
  };
}

/** Merge richer fields from intercepted SEEK JSON into an in-memory candidate row. */
export function mergeApiFieldsIntoCandidate(target, apiRow) {
  if (!target || !apiRow) return target;
  if (apiRow.email) target.email = apiRow.email;
  if (apiRow.phone) target.phone = apiRow.phone;
  if (apiRow.location) {
    target.location = apiRow.location;
    target.domicile = apiRow.domicile || apiRow.location;
  }
  if (apiRow.profileUrl) target.profileUrl = apiRow.profileUrl;
  if (apiRow.resumeUrl) target.resumeUrl = apiRow.resumeUrl;
  if (apiRow.seekStatus) target.seekStatus = apiRow.seekStatus;
  if (apiRow.appliedRole) target.appliedRole = apiRow.appliedRole;
  return target;
}

function normalizeApiJob(obj) {
  if (!obj || typeof obj !== "object") return null;

  const rawId =
  obj.jobId ??
  obj.job_id ??
  obj.id ??
  obj.advertisementId ??
  obj.advertisement_id;

  const jobId = rawId != null ? String(rawId).replace(/\D/g, "") : "";
  if (!jobId || jobId.length < 5) return null;

  const title = pickString(obj, ["title", "jobTitle", "job_title", "positionTitle", "name"]);
  const count =
  obj.candidateCount ??
  obj.candidate_count ??
  obj.applicationCount ??
  obj.application_count ??
  obj.applicationsCount;

  return {
    jobId,
    title: title || null,
    candidateCount: typeof count === "number" ? count : parseInt(String(count || "0"), 10) || 0,
  };
}

/** Runs in the browser via page.evaluate — must be self-contained. */
export function extractJobIdsFromPageHtml() {
  const jobIdRe = /[?&]jobid=(\d+)|[?&]jobId=(\d+)|"jobId"\s*:\s*"?(\d+)|"job_id"\s*:\s*"?(\d+)/gi;
  const jobs = new Map();

  const addJob = (id, title, count) => {
    if (!id) return;
    const jobId = String(id).replace(/\D/g, "");
    if (jobId.length < 5) return;
    const existing = jobs.get(jobId);
    if (!existing || (count || 0) > (existing.candidateCount || 0)) {
      jobs.set(jobId, { jobId, title: title || null, candidateCount: count || 0 });
    }
  };

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href || "";
    const m = href.match(/[?&]jobid=(\d+)|[?&]jobId=(\d+)/i);
    if (!m) return;
    const jobId = m[1] || m[2];
    const row = a.closest("tr, li, article, [role='row'], div");
    const rowText = row?.innerText || a.innerText || "";
    const countMatch = rowText.match(/(\d+)\s*(candidates?|applications?|new)/i);
    const title =
    row?.querySelector("h2, h3, strong, [data-automation*='title']")?.textContent?.trim() ||
    a.textContent?.trim() ||
    null;
    addJob(jobId, title, countMatch ? parseInt(countMatch[1], 10) : 0);
  });

  const html = document.documentElement?.innerHTML || "";
  let match;
  jobIdRe.lastIndex = 0;
  while ((match = jobIdRe.exec(html)) !== null) {
    addJob(match[1] || match[2] || match[3] || match[4], null, 0);
  }

  document.querySelectorAll("tr, [role='row'], li").forEach((row) => {
    const text = row.innerText || "";
    const title = row.querySelector("h2, h3, strong")?.textContent?.trim();
    const countMatch = text.match(/(\d+)\s*(candidates?|applications?)/i);
    const link = row.querySelector('a[href*="candidates"]');
    if (!link) return;
    const m = (link.href || "").match(/[?&]jobid=(\d+)|[?&]jobId=(\d+)/i);
    if (m) addJob(m[1] || m[2], title, countMatch ? parseInt(countMatch[1], 10) : 0);
  });

    return [...jobs.values()].sort((a, b) => b.candidateCount - a.candidateCount);
}

/** Runs in the browser via page.evaluate — must be self-contained. */
export function extractYourCandidatesFromDom() {
  const statusWords = [
    "New",
    "Inbox",
    "Prescreen",
    "Shortlist",
    "Interview",
    "Offer",
    "Accept",
    "Not Suitable",
  ];

  /** Job titles from SEEK "Most recent application" column (not candidate's current job). */
  const seekApplicationTitles = [
    "Accounting Officer",
    "Site Manager",
    "Safety Officer",
  ];

  const isJunkLine = (line) => {
    if (!line || line.length < 2) return true;
    if (/^\+?\d/.test(line)) return true;
    if (statusWords.includes(line)) return true;
    if (/^\d+$/.test(line)) return true;
    if (/^(Skip to|SEEK|Home|Jobs|Open|Expired|Draft|Past applicants|Search all)/i.test(line)) return true;
    if (/^(Name|Status|Most recent|Previous applications|Actions)$/i.test(line)) return true;
    if (/^(South|West|North|East)\s/i.test(line)) return true;
    if (/sarjana|diploma|magister|bachelor|arsitektur|keuangan/i.test(line)) return true;
    if (/^\d+\s*(minute|hour|day|week|month)s?\s*ago/i.test(line)) return true;
    return false;
  };

  const parseAppliedRole = (lines, rowText) => {
    const agoPattern = /,\s*(\d+\s*(?:minute|hour|day|week|month)s?\s*ago|yesterday|today)/i;

    for (const line of lines) {
      if (!agoPattern.test(line)) continue;
      const rolePart = line.split(",")[0].trim();
      const known = seekApplicationTitles.find((t) =>
      rolePart.toLowerCase().includes(t.toLowerCase()),
      );
      if (known) return known;
      if (rolePart.length > 0 && rolePart.length < 45) return rolePart;
    }

    for (const title of seekApplicationTitles) {
      if (lines.some((l) => l.toLowerCase().startsWith(title.toLowerCase() + ","))) {
        return title;
      }
    }

    const blob = (rowText || lines.join("\n")).toLowerCase();
    for (const title of seekApplicationTitles) {
      if (blob.includes(title.toLowerCase())) return title;
    }

    const inline = (rowText || "").match(
      /(Accounting Officer|Site Manager|Safety Officer)\s*,\s*\d+\s*(?:minute|hour|day|week|month)s?\s*ago/i,
    );
    if (inline) return inline[1];

    return null;
  };

  const parseMostRecentRole = (lines, name, appliedRole) => {
    const agoPattern = /,\s*(\d+\s*(?:minute|hour|day|week|month)s?\s*ago|yesterday|today)/i;
    return (
      lines.find(
        (l) =>
        l.length > 10 &&
        l.length < 120 &&
        l !== name &&
        l !== appliedRole &&
        !agoPattern.test(l) &&
        !statusWords.includes(l) &&
        (/\s+at\s+/i.test(l) || /\bPT[\s.]/i.test(l) || /Staff|Manager|Role/i.test(l)),
      ) || null
    );
  };

  const parseRelativeTime = (text) => {
    const m = text.match(
      /(\d+\s*(?:minute|hour|day|week|month)s?\s*ago|yesterday|today)/i,
    );
    return m ? m[0] : new Date().toISOString();
  };

  const isLikelyPersonName = (name) => {
    if (!name || name.length < 3) return false;
    if (/^(South|West|North|East|Sarjana|Diploma|Magister|Bali|Jakarta)/i.test(name)) return false;
    if (/,\s*\d{4}/.test(name)) return false;
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;
    if (!/[a-zA-Z]/.test(name)) return false;
    // SEEK sometimes shows a trailing initial only (e.g. "Feri Budi p")
    const core = words.filter((w) => w.length > 1);
    return core.length >= 2;
  };

  const findRowContainer = (phoneLink) => {
    let el = phoneLink.parentElement;
    for (let depth = 0; depth < 12 && el; depth++) {
      const text = el.innerText || "";
      if (
        text.includes("+62") &&
        statusWords.some((s) => text.includes(s)) &&
        text.length < 1200 &&
        text.length > 30
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return phoneLink.parentElement?.parentElement || phoneLink.parentElement;
  };

  const results = [];
  const seen = new Set();

  // Process rows top-to-bottom (newest applications appear first on SEEK)
  const phoneLinks = [...document.querySelectorAll('a[href^="tel:"]')]
  .map((link) => {
    const rect = link.getBoundingClientRect();
    return { link, top: rect.top, left: rect.left };
  })
  .sort((a, b) => a.top - b.top || a.left - b.left)
  .map((x) => x.link);

  for (let rowIndex = 0; rowIndex < phoneLinks.length; rowIndex++) {
    const phoneLink = phoneLinks[rowIndex];
    const container = findRowContainer(phoneLink);
    if (!container) continue;

    const rowText = (container.innerText || "").trim();
    const phone =
    phoneLink.textContent?.trim() ||
    phoneLink.getAttribute("href")?.replace(/^tel:/i, "").trim() ||
    null;

    if (!phone || !/\+?\d{8,}/.test(phone.replace(/\s/g, ""))) continue;

    const lines = rowText
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isJunkLine(s));

    let name = null;
    const phoneIdx = lines.findIndex((l) => l.includes(phone.replace(/\s/g, "")) || l === phone);
    if (phoneIdx > 0) {
      for (let i = phoneIdx - 1; i >= 0; i--) {
        const candidate = lines[i];
        if (
          candidate.length > 3 &&
          candidate.length < 80 &&
          !/^[A-Z]$/.test(candidate) &&
          !isJunkLine(candidate)
        ) {
          name = candidate;
          break;
        }
      }
    }

    if (!name) {
      name = lines.find(
        (l) =>
        l.length >= 4 &&
        l.length < 80 &&
        !isJunkLine(l) &&
        /^[A-Za-z]/.test(l),
      );
    }

    if (!name || !isLikelyPersonName(name)) continue;
    name = name.replace(/\s+/g, " ");

    const key = `${name}|${phone.replace(/\D/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const seekStatus = statusWords.find((s) => rowText.includes(s)) || "New";
    const appliedRole = parseAppliedRole(lines, rowText);
    const mostRecentRole = parseMostRecentRole(lines, name, appliedRole);

    const profileAnchor = container.querySelector(
      'a[href*="selected="], a[href*="candidates?"], a[href*="candidates/"]',
    );
    const profileUrl = profileAnchor?.href || null;
    const jobIdMatch = (profileUrl || rowText).match(/[?&]jobId?=(\d+)/i);
    const jobId = jobIdMatch ? jobIdMatch[1] : null;

    results.push({
      name,
      phone,
      email: null,
      seekStatus,
      mostRecentRole: mostRecentRole || null,
      appliedRole,
      appliedAt: parseRelativeTime(rowText),
                 appliedAtSort: rowIndex,
                 profileUrl,
                 jobId,
                 source: "SEEK",
                 location: null,
                 domicile: null,
    });
  }

  return results;
}

/** Runs in the browser via page.evaluate — must be self-contained. */
export function extractCandidateDetailFromModal() {
  /**
   * SEEK renders candidate detail as a right-side PANEL — not a modal or dialog.
   * We find the panel by looking for the container that has:
   *  - A mailto link (contact details)
   *  - AND a heading (candidate name)
   *  - AND tab navigation (Profile / Resumé / etc.)
   *
   * Fallback chain if no focused panel is found: body.
   */
  function findPanelRoot() {
    // Strategy 1: element that contains both mailto AND a tab list
    const allLinks = [...document.querySelectorAll('a[href^="mailto:"]')];
    for (const link of allLinks) {
      let el = link.parentElement;
      for (let depth = 0; depth < 12 && el && el !== document.body; depth++) {
        const hasTabs =
        el.querySelector('[role="tab"], [role="tablist"], nav a') !== null;
        const hasName = el.querySelector("h1, h2") !== null;
        if (hasTabs && hasName) return el;
        el = el.parentElement;
      }
    }
    // Strategy 2: aside element (SEEK sometimes wraps the panel in <aside>)
    const aside = document.querySelector("aside");
    if (aside && (aside.innerText || "").length > 100) return aside;
    // Strategy 3: any section/div that contains "Application questions"
    const allEls = [...document.querySelectorAll("section, div, article")];
    for (const el of allEls) {
      if (el.children.length > 30) continue; // too broad
      const txt = (el.innerText || "").toLowerCase();
      if (
        (txt.includes("application questions") ||
        txt.includes("gaji bulanan yang diinginkan") ||
        txt.includes("expected monthly salary")) &&
        txt.includes("career history")
      ) {
        return el;
      }
    }
    // Fallback: full body
    return document.body;
  }

  const root = findPanelRoot();

  const mailto = root.querySelector('a[href^="mailto:"]');
  let email = null;
  if (mailto) {
    email = (mailto.getAttribute("href") || "")
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .trim();
  }
  if (!email) {
    const body = root.innerText || "";
    const m = body.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    email = m ? m[0] : null;
  }

  const telLink = root.querySelector('a[href^="tel:"]');
  const phone =
  telLink?.textContent?.trim() ||
  telLink?.getAttribute("href")?.replace(/^tel:/i, "").trim() ||
  null;

  const h1 = root.querySelector("h1, h2");
  const name = h1?.textContent?.trim() || null;

  const profileUrl = /selected=/.test(location.href) ? location.href : null;

  const isEducationLine = (line) =>
  /sarjana|diploma|magister|bachelor|s1\b|s2\b|s3\b|arsitektur|akuntansi|degree/i.test(
    line,
  ) || /,\s*\d{4}\s*$/.test(line);

  const isJobOrNoiseLine = (line) =>
  !line ||
  line.length > 70 ||
  /@/.test(line) ||
  /^\+\d/.test(line) ||
  /^applied\b/i.test(line) ||
  /\s+at\s+/i.test(line) ||
  /officer|manager|designer|staff|engineer|consultant/i.test(line) ||
  isEducationLine(line);

  /** SEEK shows domicile as a short region/city line under contact (e.g. Jakarta, East Java, Bali). */
  const isSeekDomicileLine = (line) => {
    const t = (line || "").trim();
    if (!t || t.length < 2 || t.length > 55) return false;
    if (isJobOrNoiseLine(t)) return false;
    if (t === name) return false;

    if (/^(East|West|Central|North|South)\s+Java$/i.test(t)) return true;
    if (
      /^(Bali|Jakarta|Surabaya|Bandung|Yogyakarta|Semarang|Medan|Denpasar|Malang|Solo|Bogor|Bekasi|Depok|Tangerang|Batam|Makassar|Palembang|Balikpapan|Cirebon|Padang|Pontianak|Manado|Ambon|Jayapura|Kupang|Mataram|Kendari|Palu|Tarakan|Samarinda|Banjarbaru|Pekanbaru|Jambi|Bengkulu|Lampung|Serang|Cilegon|Sukabumi|Garut|Tasikmalaya|Cimahi)$/i.test(
        t,
      )
    ) {
      return true;
    }
    if (/^(DKI|DI)\s/i.test(t)) return true;
    if (/^(Kabupaten|Kota)\s/i.test(t)) return true;
    if (
      /java|jakarta|bali|yogyakarta|sumatra|sumatera|kalimantan|sulawesi|papua|banten|aceh|riau|lombok|maluku|nusa\s+tenggara|ntb|ntt|indonesia|jawa\s+timur|jawa\s+tengah|jawa\s+barat/i.test(
        t,
      ) &&
      !/\d{5,}/.test(t)
    ) {
      return true;
    }
    return false;
  };

  const normalizeDomicile = (raw) => {
    const t = (raw || "").trim();
    if (!t || !isSeekDomicileLine(t)) return null;
    return t.replace(/\s+/g, " ");
  };

  let domicileLocation = null;

  const locAutomation = root.querySelector(
    '[data-automation*="location"], [data-automation*="address"], [data-automation*="domicile"]',
  );
  if (locAutomation) {
    domicileLocation = normalizeDomicile(locAutomation.textContent);
  }

  // Pin icon row (location sits beside the map-pin SVG in the profile header)
  if (!domicileLocation) {
    for (const svg of root.querySelectorAll("svg")) {
      const row =
      svg.closest("div, span, p, li, [data-automation]")?.parentElement ||
      svg.parentElement;
      if (!row) continue;
      const lines = (row.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
      for (const line of lines) {
        const loc = normalizeDomicile(line);
        if (loc) {
          domicileLocation = loc;
          break;
        }
      }
      if (domicileLocation) break;
    }
  }

  // Header lines immediately after phone / email (SEEK order: role → email | phone → location → education)
  if (!domicileLocation) {
    const headerRoot =
    h1?.closest("header, section, div") ||
    root.querySelector('[data-automation*="candidate-header"]') ||
    root;
    const lines = (headerRoot.innerText || root.innerText || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

    const contactIdx = lines.findIndex(
      (l) => l.includes("@") || /^\+\d[\d\s-]{8,}/.test(l),
    );
    const searchFrom = contactIdx >= 0 ? contactIdx + 1 : 0;
    const searchTo = Math.min(searchFrom + 6, lines.length);

    for (let i = searchFrom; i < searchTo; i++) {
      const loc = normalizeDomicile(lines[i]);
      if (loc) {
        domicileLocation = loc;
        break;
      }
    }
  }

  if (!domicileLocation) {
    const locEl = [...root.querySelectorAll("span, p, div, li")].find((el) => {
      if (el.children.length > 2) return false;
      const t = (el.textContent || "").trim();
      return isSeekDomicileLine(t);
    });
    if (locEl) domicileLocation = normalizeDomicile(locEl.textContent);
  }

  // Application questions / Screening questions: SEEK shows candidate answers
  // here. The most important one for ATS analytics is "Expected monthly salary".
  const { expectedSalaryRaw, expectedSalary, expectedSalaryCurrency } =
  extractExpectedSalaryFromModal(root);

  // Extract seekProfileId from the current URL (?selected=UUID)
  const _seekIdMatch = (profileUrl || "").match(/[?&]selected=([0-9a-f-]{36})/i);
  const seekProfileId = _seekIdMatch ? _seekIdMatch[1] : null;

  // Task 5: always log raw email so mismatches are visible in scraper output
  console.log("[SEEK RAW EMAIL]", JSON.stringify(email));
  console.log("[SEEK PROFILE ID]", JSON.stringify(seekProfileId));

  return {
    name,
    email,
    phone,
    profileUrl,
    seekProfileId,
    location: domicileLocation,
    expectedSalaryRaw,
    expectedSalary,
    expectedSalaryCurrency,
  };
}

// --- Salary formatting (Node-callable) --------------------------------
//
// Used by the scraper and the ATS bridge to turn the raw extraction
// triple ({raw, amount, currency}) into a single human-readable string
// like "IDR 15,000,000 / month". The raw text is preserved verbatim
// when the parser couldn't normalize it so HR always sees what the
// candidate typed.

/**
 * Build a single display string for the ATS `salaryExpectation` column.
 *
 * @param {Object} info
 * @param {string|null} [info.raw]      raw text from SEEK (e.g. "Rp 15 juta")
 * @param {number|null} [info.amount]   parsed numeric monthly amount
 * @param {string|null} [info.currency] ISO 3-letter code (e.g. "IDR")
 * @returns {string|null}
 */
export function formatSalaryDisplay({ raw, amount, currency } = {}) {
  if (amount != null && Number.isFinite(amount)) {
    const code = (currency || "IDR").toUpperCase();
    const formatted = new Intl.NumberFormat("en-US").format(amount);
    return `${code} ${formatted} / month`;
  }
  const text = (raw || "").trim();
  return text.length > 0 ? text : null;
}

// --- Salary extraction -------------------------------------------------
//
// SEEK shows screening/application questions as a label/value pair. We scan
// every element in the modal for a label that matches "expected monthly
// salary" (or variants), then parse the value. Examples seen in the wild:
//
//   "Rp 15 million"             -> 15000000  IDR
//   "Rp 15.000.000"             -> 15000000  IDR
//   "IDR 15,000,000"            -> 15000000  IDR
//   "Rp 15 jt"                  -> 15000000  IDR
//   "USD 2,000"                 -> 2000      USD
//   "SGD 3.5k"                  -> 3500      SGD
//   "Rp 10-15 juta"             -> null      (range -- we return null rather than guess)
//
// The raw text is always preserved so the ATS can display exactly what the
// candidate typed, even when the parser couldn't normalize it.

const SALARY_LABEL_PATTERNS = [
  // English
  /expected\s+monthly\s+salary/i,
/expected\s+salary/i,
/monthly\s+salary\s+expectation/i,
/salary\s+expectation/i,
// Indonesian
/gaji\s+bulanan\s+yang\s+diinginkan/i,
/gaji\s+bulanan\s+yang\s+diharapkan/i,
/gaji\s+yang\s+diharapkan/i,
/gaji\s+yang\s+diinginkan/i,
/ekspektasi\s+gaji(?:\s+bulanan)?/i,
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSalaryLabel(text) {
  const t = (text || "").trim();
  if (!t || t.length > 80) return false;
  return SALARY_LABEL_PATTERNS.some((re) => re.test(t));
}

const UNIT_MULTIPLIERS = {
  thousand: 1_000,
  k: 1_000,
  rb: 1_000,
  ribu: 1_000,
  million: 1_000_000,
  m: 1_000_000,
  jt: 1_000_000,
  juta: 1_000_000,
  billion: 1_000_000_000,
  b: 1_000_000_000,
  miliar: 1_000_000_000,
  milyar: 1_000_000_000,
};

const CURRENCY_TOKENS = [
  "IDR",
"USD",
"SGD",
"MYR",
"AUD",
"EUR",
"GBP",
"JPY",
"CNY",
"HKD",
"PHP",
"THB",
"VND",
];

/**
 * Try to extract the candidate's expected monthly salary from the modal DOM.
 *
 * Returns:
 *   { expectedSalaryRaw, expectedSalary, expectedSalaryCurrency }
 *
 * Where:
 *   - expectedSalaryRaw     = the original text exactly as displayed on SEEK (or null)
 *   - expectedSalary        = numeric monthly amount (or null if unparseable)
 *   - expectedSalaryCurrency = ISO 3-letter code; defaults to "IDR" when a value
 *                              is detected without an explicit currency (SEEK is
 *                              id.employer.seek.com so IDR is the safe default).
 */
function extractExpectedSalaryFromModal(root) {
  try {
    const result = {
      expectedSalaryRaw: null,
      expectedSalary: null,
      expectedSalaryCurrency: null,
    };

    // 1) Narrow to the "Application questions" section if present.
    //    SEEK renders: heading "Application questions" then label/value pairs.
    let searchRoot = root;
    const allPageEls = [...root.querySelectorAll("h2, h3, h4, strong, b, div, section")];
    for (const el of allPageEls) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === "application questions" || t === "pertanyaan penyaringan") {
        // Use the parent container of this heading as search scope
        searchRoot = el.parentElement || root;
        break;
      }
    }

    // 2) Look for explicit label/value rows. SEEK uses adjacent divs:
    //    <div>Gaji bulanan yang diinginkan</div><div>Rp 8 Jt</div>
    const candidates = [
      ...searchRoot.querySelectorAll("dt, dd, div, span, li, p, label, td, th"),
    ].filter((el) => el.children.length <= 5);

    for (const el of candidates) {
      const labelText = (el.textContent || "").trim();
      if (!isSalaryLabel(labelText)) continue;
      if (labelText.length > 80) continue; // too long to be just a label

      const valueNode = findSalaryValueNear(el, root);
      if (valueNode) {
        const raw = (valueNode.textContent || "").trim();
        if (raw && raw.length <= 80 && !isSalaryLabel(raw)) {
          result.expectedSalaryRaw = raw;
          break;
        }
      }
    }

    // 3) Fallback: scan the innerText of the panel for the salary value.
    //    From real SEEK data the pattern is simply:
    //      line N:   "Gaji bulanan yang diinginkan"
    //      line N+1: "Rp 8 Jt"
    //    (sometimes with blank lines between them)
    if (!result.expectedSalaryRaw) {
      const allText = (root.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
      const labelIdx = allText.findIndex((l) => isSalaryLabel(l));
      if (labelIdx >= 0) {
        for (
          let i = labelIdx + 1;
        i < Math.min(labelIdx + 10, allText.length);
        i++
        ) {
          const candidate = allText[i];
          if (!candidate) continue;
          if (isSalaryLabel(candidate)) break; // next label = give up
          if (candidate.length > 120) continue;
          // Skip em-dash / en-dash = "not answered"
          if (/^[—–-]+$/.test(candidate)) {
            result.expectedSalaryRaw = null;
            break;
          }
          result.expectedSalaryRaw = candidate;
          break;
        }
      }
    }

    if (!result.expectedSalaryRaw) {
      return result;
    }

    // 3) Normalize the raw string into a numeric amount + currency.
    const parsed = parseSalaryString(result.expectedSalaryRaw);
    if (parsed.amount != null) {
      result.expectedSalary = parsed.amount;
      result.expectedSalaryCurrency = parsed.currency || "IDR";
    } else {
      // No number was found in the raw text. Keep the raw text (HR can see
      // what the candidate typed) but don't claim a default currency.
      result.expectedSalary = null;
      result.expectedSalaryCurrency = null;
    }

    return result;
  } catch (err) {
    console.warn(
      "[seek-extract] salary extraction failed:",
      err && err.message ? err.message : err,
    );
    return {
      expectedSalaryRaw: null,
      expectedSalary: null,
      expectedSalaryCurrency: null,
    };
  }
}

function findSalaryValueNear(labelEl, root) {
  // Strategy 1: direct next siblings (up to 5)
  let n = labelEl.nextElementSibling;
  for (let i = 0; i < 5 && n; i++, n = n.nextElementSibling) {
    const t = (n.textContent || "").trim();
    if (t && t.length <= 120 && !isSalaryLabel(t)) return n;
  }

  // Strategy 2: parent's next siblings
  const parent = labelEl.parentElement;
  if (parent) {
    let ps = parent.nextElementSibling;
    for (let i = 0; i < 4 && ps; i++, ps = ps.nextElementSibling) {
      const pt = (ps.textContent || "").trim();
      if (pt && pt.length <= 120 && !isSalaryLabel(pt)) {
        // Prefer a leaf child over the whole sibling
        const leaf = ps.querySelector("span, p, dd, [data-automation*='value']");
        if (leaf) {
          const lt = (leaf.textContent || "").trim();
          if (lt && lt.length <= 120 && !isSalaryLabel(lt)) return leaf;
        }
        return ps;
      }
    }
  }

  // Strategy 3: grandparent scan
  const gp = parent?.parentElement;
  if (gp) {
    const kids = [...gp.querySelectorAll("div, span, dd, p")].filter((el) => {
      if (el === labelEl || el.contains(labelEl)) return false;
      if (el.children.length > 3) return false;
      const t = (el.textContent || "").trim();
      return t.length > 0 && t.length <= 120 && !isSalaryLabel(t);
    });
    // Pick the first kid that appears AFTER the label in DOM order
    for (const kid of kids) {
      if (labelEl.compareDocumentPosition(kid) & Node.DOCUMENT_POSITION_FOLLOWING) {
        return kid;
      }
    }
  }

  return null;
}

/**
 * Parse a salary string like "Rp 15 million" or "IDR 15,000,000" into a
 * numeric amount and currency code.
 */
function parseSalaryString(raw) {
  if (!raw) return { amount: null, currency: null };

  const text = raw.trim();
  const result = { amount: null, currency: null };

  // 1) Detect currency
  const upper = text.toUpperCase();
  for (const c of CURRENCY_TOKENS) {
    if (upper.includes(c)) {
      result.currency = c;
      break;
    }
  }
  // Common symbols
  if (!result.currency) {
    if (text.includes("Rp") || text.includes("rp")) result.currency = "IDR";
    else if (text.includes("$")) result.currency = "USD";
    else if (text.includes("S$")) result.currency = "SGD";
  }
  // Per spec: if no currency is detected at all, default to IDR (the SEEK
  // instance is id.employer.seek.com so this is the safe default). However,
  // if no number is found we still return currency=null so the caller can
  // distinguish "no salary info" from "IDR with a value".
  if (!result.currency) {
    result.currency = "IDR";
  }

  if (/\d+\s*[-–—]\s*\d+/.test(text)) {
    const numbers = text.match(/-?\d[\d.,]*/g) || [];
    if (numbers.length >= 2) {
      return { amount: null, currency: result.currency };
    }
  }

  let body = text
  .replace(/IDR|USD|SGD|MYR|AUD|EUR|GBP|JPY|CNY|HKD|PHP|THB|VND/gi, "")
  .replace(/Rp|rp/gi, "")
  .replace(/[$\u00A3\u20AC\u00A5]/g, "")
  .trim();

  // Multiplier word (million, juta, etc.) -> multiplier.
  // Pick the LONGEST matching key so "milyar" beats "m", "million" beats
  // "m", "juta" beats "jt", etc. Use lookarounds so the multiplier can
  // attach to a digit (e.g. "3.5k") where there's no word boundary.
  let multiplier = 1;
  const lower = body.toLowerCase();
  const keys = Object.keys(UNIT_MULTIPLIERS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const re = new RegExp(
      `(?<![\w])${escapeRegex(key)}(?![\w])`,
                          "i",
    );
    if (re.test(lower)) {
      multiplier = UNIT_MULTIPLIERS[key];
      break;
    }
  }

  // Find the first number in the body
  const numMatch = body.match(/-?\d[\d.,]*/);
  if (!numMatch) return { amount: null, currency: result.currency };

  let numStr = numMatch[0];

  // Normalize thousands / decimal separators. Rules:
  //   - If BOTH comma and dot present, the rightmost separator is the decimal.
  //     e.g. "1,234.56" -> 1234.56
  //   - If only one type:
  //     - "15,000,000" (multiple commas, each group 3 digits) -> 15000000
  //     - "15,000"     (one comma, 3 trailing digits)         -> 15000
  //     - "1.000.000"  (multiple dots, each group 3 digits)    -> 1000000
  //     - "1.2"        (one dot, NOT 3 trailing digits)        -> 1.2
  //     - "1.200"      (one dot, 3 trailing digits)           -> 1200
  const dots = (numStr.match(/\./g) || []).length;
  const commas = (numStr.match(/,/g) || []).length;
  if (dots > 0 && commas > 0) {
    // rightmost is decimal; the others are thousands
    if (numStr.lastIndexOf(".") > numStr.lastIndexOf(",")) {
      // e.g. 1,234.56
      numStr = numStr.replace(/,/g, "");
    } else {
      // e.g. 1.234,56
      numStr = numStr.replace(/\./g, "").replace(",", ".");
    }
  } else if (commas > 1) {
    // "15,000,000" -> all commas are thousands
    numStr = numStr.replace(/,/g, "");
  } else if (commas === 1) {
    // "15,000" vs "15,5" — decide by trailing group length
    const parts = numStr.split(",");
    if (parts.length === 2 && parts[1].length === 3) {
      numStr = parts.join("");
    } else {
      numStr = numStr.replace(",", ".");
    }
  } else if (dots > 1) {
    // "1.000.000" -> all dots are thousands
    numStr = numStr.replace(/\./g, "");
  } else if (dots === 1) {
    // "1.2" stays as 1.2; "1.200" is ambiguous but most likely thousands
    const parts = numStr.split(".");
    if (parts.length === 2 && parts[1].length === 3) {
      numStr = parts.join("");
    }
    // else: leave as is (decimal like 1.2)
  }

  const n = parseFloat(numStr);
  if (!Number.isFinite(n)) return { amount: null, currency: result.currency };

  result.amount = Math.round(n * multiplier);
  return result;
}

/**
 * Click a Past-applicants row (names are often not <a> links).
 * Runs in the browser via page.evaluate.
 */
export function clickYourCandidatesRowByPhone(phoneDigits) {
  const tail = String(phoneDigits || "").replace(/\D/g, "").slice(-10);
  if (tail.length < 8) return { ok: false, reason: "bad phone" };

  const tel = [...document.querySelectorAll('a[href^="tel:"]')].find((a) => {
    const d = (a.textContent || a.getAttribute("href") || "").replace(/\D/g, "");
    return d.endsWith(tail) || d.includes(tail);
  });
  if (!tel) return { ok: false, reason: "no tel link" };

  const row = tel.closest("tr") || tel.closest('[role="row"]');
  if (!row) return { ok: false, reason: "no row" };

  const profileA = row.querySelector(
    'a[href*="selected="], a[href*="candidates?"], a[href*="candidates/"]',
  );
  if (profileA?.href) {
    profileA.click();
    return { ok: true, method: "profile-anchor", href: profileA.href };
  }

  const firstCell = row.querySelector("td");
  if (firstCell) {
    const btn = firstCell.querySelector('button, a, [role="button"], [tabindex="0"]');
    const target = btn || firstCell;
    target.click();
    return { ok: true, method: btn ? "name-button" : "name-cell", tag: target.tagName };
  }

  row.click();
  return { ok: true, method: "row-click" };
}

/** Runs in the browser via page.evaluate — must be self-contained. */
export function extractCandidateCardsFromDom(jobTitle) {
  const statusWords = [
    "New",
    "Inbox",
    "Prescreen",
    "Shortlist",
    "Interview",
    "Offer",
    "Accept",
    "Not Suitable",
  ];
  const results = [];
  const seen = new Set();

  const pushCard = (card) => {
    const text = (card.innerText || "").trim();
    if (!text || text.length < 5) return;

    const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

    const name =
    card.querySelector(
      "h1, h2, h3, h4, strong, [data-automation*='name'], [data-automation*='candidate']",
    )?.textContent?.trim() ||
    lines.find(
      (l) =>
      l.length > 2 &&
      l.length < 80 &&
      !statusWords.includes(l) &&
      !/applied|screening|match|applications/i.test(l) &&
      !/bali|jakarta|java|indonesia/i.test(l.toLowerCase()) &&
      !/^\d+\/\d+/.test(l),
    ) ||
    null;

    if (!name || name.length < 2) return;

    const seekStatus = statusWords.find((s) => text.includes(s)) || "New";

    const appliedMatch = text.match(
      /Applied\s+(\d+\s+\w+\s+ago|yesterday|today|\d+\s+minutes?\s+ago)/i,
    );
    const appliedAt = appliedMatch ? appliedMatch[0] : new Date().toISOString();

    const profileLink = card.querySelector('a[href*="selected="], a[href*="candidate"]');

    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      name: name.replace(/\s+/g, " "),
                 phone: null,
                 email: null,
                 seekStatus,
                 appliedRole: jobTitle || null,
                 mostRecentRole: jobTitle || null,
                 appliedAt,
                 profileUrl: profileLink?.href || null,
                 source: "SEEK",
    });
  };

  const selectedLinks = [...document.querySelectorAll('a[href*="selected="]')];
  let cards = selectedLinks.map(
    (a) => a.closest("article, li, [data-automation], section, div") || a,
  );

  if (cards.length === 0) {
    const cardSelectors = [
      '[data-automation*="candidate-card"]',
      '[data-automation*="application-card"]',
      '[data-automation*="candidate"]',
      "article",
      '[class*="CandidateCard"]',
      '[class*="candidate-card"]',
      '[class*="ApplicationCard"]',
    ];
    for (const sel of cardSelectors) {
      const found = [...document.querySelectorAll(sel)].filter((el) => {
        const t = (el.innerText || "").trim();
        return t.length > 10 && t.length < 4000 && /applied/i.test(t);
      });
      if (found.length > 0) {
        cards = found;
        break;
      }
    }
  }

  for (const card of cards) {
    pushCard(card);
  }

  if (results.length === 0) {
    const appliedMarkers = [...document.querySelectorAll("*")].filter((el) => {
      if (el.children.length > 8) return false;
      const t = (el.textContent || "").trim();
      return /^Applied\s+/i.test(t) && t.length < 60;
    });

    for (const marker of appliedMarkers) {
      const container =
      marker.closest("article, li, section, [data-automation], div")?.parentElement
      ?.closest("article, li, section, [data-automation], div") ||
      marker.closest("article, li, section, [data-automation], div");
      if (container) pushCard(container);
    }
  }

  return results;
}
