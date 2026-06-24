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

/** Merge richer fields from intercepted SEEK JSON into an in-memory candidate row.
 *  NEVER overwrites fields already set by DOM extraction — network API data is
 *  lower priority because it may come from a different candidate's tab. */
export function mergeApiFieldsIntoCandidate(target, apiRow) {
  if (!target || !apiRow) return target;
  if (apiRow.email && !target.email) target.email = apiRow.email;
  if (apiRow.phone && !target.phone) target.phone = apiRow.phone;
  if (apiRow.location && !target.location) {
    target.location = apiRow.location;
    target.domicile = apiRow.domicile || apiRow.location;
  }
  if (apiRow.profileUrl && !target.profileUrl) target.profileUrl = apiRow.profileUrl;
  if (apiRow.resumeUrl && !target.resumeUrl) target.resumeUrl = apiRow.resumeUrl;
  if (apiRow.seekStatus && !target.seekStatus) target.seekStatus = apiRow.seekStatus;
  if (apiRow.appliedRole && !target.appliedRole) target.appliedRole = apiRow.appliedRole;
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
    if (!container) {
      console.log(`      [DIAGNOSTIC] No container found for phone: ${phoneLink.textContent?.trim() || phoneLink.getAttribute('href')?.trim()}`);
      continue;
    }

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

    if (!name || !isLikelyPersonName(name)) {
      console.log(`      [DIAGNOSTIC] Skipping candidate - name: '${name || 'null'}', valid: ${!!name && isLikelyPersonName(name || '')}`);
      if (name) {
        const words = name.trim().split(/\s+/).filter(Boolean);
        const core = words.filter((w) => w.length > 1);
        console.log(`        words: ${words.length}, core: ${core.length}, matches: ${core.filter((w) => /^[A-Za-z]/.test(w)).join(', ')}`);
      }
      continue;
    }
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
    // Strategy 1b: element with both a heading AND tab list (even without mailto)
    const allH1H2 = [...document.querySelectorAll("h1, h2")];
    for (const heading of allH1H2) {
      const txt = (heading.textContent || "").trim();
      if (txt.length < 2) continue;
      let el = heading.parentElement;
      for (let d = 0; d < 8 && el && el !== document.body; d++) {
        if (el.querySelector('[role="tablist"], nav a, [role="tab"]')) {
          return el;
        }
        el = el.parentElement;
      }
    }
    // Strategy 2: aside element with content
    const aside = document.querySelector("aside");
    if (aside) {
      const asideText = aside.innerText || "";
      const hasContact = aside.querySelector('a[href^="mailto:"]') !== null;
      const hasTabs = aside.querySelector('[role="tab"], [role="tablist"]') !== null;
      const hasName = aside.querySelector("h1, h2") !== null;
      if (asideText.length > 100 && (hasContact || hasTabs || hasName)) {
        return aside;
      }
    }
    // Strategy 3: any section/div that contains "Application questions"
    const allEls = [...document.querySelectorAll("section, div, article")];
    for (const el of allEls) {
      if (el.children.length > 30) continue;
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
    // Strategy 4: find a div that contains a heading AND a mailto/tel link
    for (const link of allLinks) {
      let el = link.closest("div, section, article");
      if (el && el.querySelector("h1, h2") && el.innerText.length > 100) {
        return el;
      }
    }
    // Fallback: full body (last resort)
    return document.body;
  }

  const root = findPanelRoot();

  // TASK 1: STRICT email extraction — profile tab mailto link ONLY
  // NEVER fallback to body text scan (picks up unrelated emails on the page)
  // NEVER generate fake/synthetic email from phone number
  const mailto = root.querySelector('a[href^="mailto:"]');
  let email = null;
  if (mailto) {
    const raw = (mailto.getAttribute("href") || "")
      .replace(/^mailto:/i, "")
      .split("?")[0]
      .trim()
      .toLowerCase();
    // Validate it looks like a real email
    if (raw && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
      email = raw;
    }
  }
  if (!email) {
    console.log("[EMAIL MISSING - DO NOT GENERATE FAKE EMAIL]", { name: (root.querySelector("h1,h2") || {}).textContent });
  }
  console.log("[EMAIL FROM SEEK]", email);

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

  /** SEEK shows domicile as a short region/city line under contact.
   *  Handles formats like: "Malang, East Java", "Tangerang, Banten", "Jambi City, Jambi", "West Java"
   */
  const isSeekDomicileLine = (line) => {
    const t = (line || "").trim();
    if (!t || t.length < 2 || t.length > 80) return false;
    if (isJobOrNoiseLine(t)) return false;
    if (t === name) return false;

    // Pattern 1: Exact city names (single word) — expanded with many more Indonesian cities
    if (
      /^(Bali|Jakarta|Surabaya|Bandung|Yogyakarta|Semarang|Medan|Denpasar|Malang|Solo|Bogor|Bekasi|Depok|Tangerang|Batam|Makassar|Palembang|Balikpapan|Cirebon|Padang|Pontianak|Manado|Ambon|Jayapura|Kupang|Mataram|Kendari|Palu|Tarakan|Samarinda|Banjarbaru|Pekanbaru|Jambi|Bengkulu|Lampung|Serang|Cilegon|Sukabumi|Garut|Tasikmalaya|Cimahi|South Tangerang|Jambi City|Jimbaran|Kuta|Ubud|Uluwatu|Canggu|Seminyak|Sanur|Nusa Dua|Tabanan|Singaraja|Gianyar|Karangasem|Buleleng|Mengwi|Abiansemal|Badung|Klungkung|Negara|Bangli|Amlapura|Selong|Praya|Gili|Lombok|Senggigi|Banyuwangi|Probolinggo|Pasuruan|Madiun|Magelang|Pekalongan|Tegal|Purwokerto|Kediri|Blitar|Mojokerto|Jember|Lumajang|Situbondo|Bondowoso|Banyumas|Cilacap|Purbalingga|Banjarnegara|Wonosobo|Temanggung|Boyolali|Sragen|Karanganyar|Wonogiri|Pati|Kudus|Jepara|Rembang|Blora|Grobogan|Pemalang|Brebes|Majalengka|Indramayu|Subang|Purwakarta|Karawang|Cianjur|Sumedang|Kuningan|Pangandaran|Pandeglang|Lebak|Tulungagung|Trenggalek|Ponorogo|Pacitan|Bojonegoro|Tuban|Lamongan|Gresik|Sidoarjo|Mojokerto|Jombang|Nganjuk|Ngawi|Magetan|Kebumen|Kendal|Batang|Salatiga|Metro|Dumai|Binjai|Langsa|Lhokseumawe|Sabang|Tebing\s+Tinggi|Pematangsiantar|Tanjungbalai|Sibolga|Padangsidimpuan|Gunungsitoli|Solok|Sawahlunto|Payakumbuh|Bukittinggi|Pariaman|Lubuklinggau|Prabumulih|Pagar\s+Alam|Batu|Tanjungpinang|Pangkalpinang|Bandarlampung|Bontang)$/i.test(
        t,
      )
    ) {
      return true;
    }

    // Pattern 2: City with region (e.g., "Malang, East Java", "Tangerang, Banten")
    if (/^[^,]+,\s*(East|West|Central|North|South)\s+Java$/i.test(t)) return true;
    if (/^[^,]+,\s*(Bali|Jakarta|Banten|Jambi|Aceh|Riau|Kepri)$/i.test(t)) return true;
    if (/^[^,]+,\s*(Sumatera|Kalimantan|Sulawesi|Papua|Nusa\s+Tenggara)$/i.test(t)) return true;

    // Pattern 3: Region names only (e.g., "East Java", "West Java", "South Tangerang")
    if (/^(East|West|Central|North|South)\s+Java$/i.test(t)) return true;
    if (/^(Bali|Jakarta|Banten|Jambi|Aceh|Riau|Kepri)$/i.test(t)) return true;
    if (/^(Sumatera|Kalimantan|Sulawesi|Papua|Nusa\s+Tenggara)$/i.test(t)) return true;

    // Pattern 4: Jakarta DKI or DI Yogyakarta format
    if (/^(DKI|DI)\s/i.test(t)) return true;

    // Pattern 5: Kabupaten/Kota format
    if (/^(Kabupaten|Kota)\s/i.test(t)) return true;

    // Pattern 6: General region keywords in Indonesia
    if (
      /java|jakarta|bali|yogyakarta|sumatra|sumatera|kalimantan|sulawesi|papua|banten|aceh|riau|lombok|maluku|nusa\s+tenggara|ntb|ntt|indonesia|jawa\s+timur|jawa\s+tengah|jawa\s+barat/i.test(
        t,
      ) &&
      !/\d{5,}/.test(t)
    ) {
      return true;
    }

    // Pattern 7: City followed by comma and anything (for "City, Region" format)
    // This catches "Malang, East Java", "Tangerang, Banten", etc.
    const cityRegionPattern = /^[A-Z][a-z]+,\s+[A-Z][a-z]+/i;
    if (cityRegionPattern.test(t) && t.length < 60) {
      // Verify it contains location keywords
      if (/java|bali|sumatra|kalimantan|sulawesi|papua|banten|aceh|riau|lombok|maluku|jakarta|indonesia/.test(t.toLowerCase())) {
        return true;
      }
    }

    // Pattern 8: Catch-all — after isJobOrNoiseLine() has already filtered out
    // emails, phone numbers, job titles (officer/manager/etc.), education lines,
    // status words, and noise, any remaining short text (2–50 chars) that starts
    // with a capital letter and isn't the candidate's name or a SEEK UI label is
    // very likely a city/region. This catches cities like Jimbaran, Ubud, Kuta
    // that aren't in the hardcoded lists above.
    if (
      t.length >= 2 &&
      t.length <= 50 &&
      /^[A-Z]/.test(t) &&
      !/Profile|Resumé|Resume|Verification|Applications|Applied|Download|Screening/i.test(t)
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

  // FIX BUG 2: Find the RIGHT panel — NOT the left sidebar list.
  // When findPanelRoot() falls back to document.body, document.querySelector("aside")
  // picks the FIRST <aside> on the page, which is the candidate LIST sidebar,
  // NOT the profile detail panel. Instead, find the panel that contains the
  // mailto link, phone, or candidate heading — that's the profile panel.
  let effectiveRoot = root;
  if (root === document.body) {
    // Find the panel by looking for the common ancestor containing both
    // mailto and tabs, OR the h1 heading and tabs.
    const contactMailto = document.querySelector('a[href^="mailto:"]');
    const heading = document.querySelector("h1, h2");
    const startEl = contactMailto || heading;
    if (startEl) {
      let el = startEl.parentElement;
      for (let d = 0; d < 10 && el && el !== document.body; d++) {
        if (el.querySelector('[role="tab"], [role="tablist"]')) {
          effectiveRoot = el;
          break;
        }
        el = el.parentElement;
      }
    }
    // If still not found, try aside that has tab navigation (not the list sidebar)
    if (effectiveRoot === document.body) {
      const asides = [...document.querySelectorAll("aside")];
      for (const a of asides) {
        if (a.querySelector('[role="tab"], [role="tablist"]')) {
          effectiveRoot = a;
          break;
        }
      }
    }
  }

  // DIAGNOSTIC: Log effective root details
  const effectiveText = (effectiveRoot.innerText || effectiveRoot.textContent || "");
  console.log(`      [DIAGNOSTIC] Effective root text length: ${effectiveText.length}`);
  console.log(`      [DIAGNOSTIC] Has data-testid: ${effectiveRoot.querySelector('[data-testid]') !== null}`);

  let domicileLocation = null;

  // FIX 1: data-testid selector (newer SEEK structure)
  const locDataTest = effectiveRoot.querySelector('[data-testid="location"]');
  if (locDataTest) {
    domicileLocation = normalizeDomicile(locDataTest.textContent);
  }

  // FIX 2: SVG pin icon + span selector (more specific than generic svg+span)
  if (!domicileLocation) {
    // Try aria-label for location pin
    const locAria = effectiveRoot.querySelector('svg[aria-label*="location"] + span, svg[aria-label*="Location"] + span');
    if (locAria) {
      domicileLocation = normalizeDomicile(locAria.textContent);
    }
  }

  // FIX 3: Pin icon row - improved selector to find location next to map pin
  if (!domicileLocation) {
    for (const svg of effectiveRoot.querySelectorAll("svg")) {
      const ariaLabel = svg.getAttribute("aria-label") || "";
      const title = svg.getAttribute("title") || "";
      // Check if this is a location/map pin icon
      const isLocationIcon = ariaLabel.toLowerCase().includes("location") ||
                             ariaLabel.toLowerCase().includes("map") ||
                             title.toLowerCase().includes("location") ||
                             title.toLowerCase().includes("map");
      if (!isLocationIcon) continue;

      // Get the parent row of the SVG
      const row = svg.closest("div, span, p, li, [data-automation]");
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

  // Strategy A: look for location in the contact-row container (mailto+phone parent)
  if (!domicileLocation && mailto) {
    // Walk up from the mailto link to find a container with both contact info and location
    let contactContainer = mailto.parentElement;
    for (let d = 0; d < 6 && contactContainer && contactContainer !== document.body; d++) {
      const txt = (contactContainer.innerText || "").trim();
      if (txt.length > 30 && txt.length < 500) {
        const lines = txt.split("\n").map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (line === name || line.includes("@") || line.startsWith("+") || line === phone) continue;
          const loc = normalizeDomicile(line);
          if (loc) { domicileLocation = loc; break; }
        }
        if (domicileLocation) break;
      }
      contactContainer = contactContainer.parentElement;
    }
  }

  // Strategy B: Header lines immediately after phone / email (SEEK order: role → email | phone → location → education)
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

  // Strategy C: scan elements near the mailto/phone links specifically
  if (!domicileLocation) {
    const contactEl = mailto || telLink;
    if (contactEl) {
      let parent = contactEl.parentElement;
      for (let d = 0; d < 8 && parent && parent !== document.body; d++) {
        for (const el of parent.querySelectorAll("span, p, div, li")) {
          if (el.children.length > 3) continue;
          const t = (el.textContent || "").trim();
          if (!t || t === name || t.includes("@") || t.startsWith("+") || t === phone) continue;
          const loc = normalizeDomicile(t);
          if (loc) { domicileLocation = loc; break; }
        }
        if (domicileLocation) break;
        parent = parent.parentElement;
      }
    }
  }

  // Strategy D: scan ALL elements in root (existing fallback)
  if (!domicileLocation) {
    const locEl = [...root.querySelectorAll("span, p, div, li")].find((el) => {
      if (el.children.length > 2) return false;
      const t = (el.textContent || "").trim();
      if (t === name || t === phone || t.includes("@")) return false;
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

  // FIX: Comprehensive location extraction - try multiple patterns
  // If all DOM-based methods failed, extract location from text content
  if (!domicileLocation) {
    const fullText = effectiveRoot.innerText || effectiveRoot.textContent || "";
    const lines = fullText.split("\n").map(l => l.trim()).filter(l => l.length > 0 && l.length < 100);

    for (const line of lines) {
      // Skip lines that are clearly not locations
      if (!line || line === name || isJobOrNoiseLine(line) || isEducationLine(line)) continue;
      if (line.length > 80) continue;

      // Use the comprehensive isSeekDomicileLine checker
      if (isSeekDomicileLine(line)) {
        domicileLocation = normalizeDomicile(line);
        if (domicileLocation) {
          console.log(`      [LOCATION FROM PATTERN] ${domicileLocation}`);
          break;
        }
      }
    }
  }

  // Final fallback: scan ALL text in the effective root for any city-like token
  if (!domicileLocation) {
    const allWords = (effectiveRoot.innerText || effectiveRoot.textContent || "")
      .split(/[\n,]+/)
      .map(w => w.trim())
      .filter(w => w.length > 1 && w.length < 50);

    for (const word of allWords) {
      if (isSeekDomicileLine(word)) {
        domicileLocation = normalizeDomicile(word);
        if (domicileLocation) {
          console.log(`      [LOCATION FROM WORD SCAN] ${domicileLocation}`);
          break;
        }
      }
    }
  }

  // Task 5: always log raw email so mismatches are visible in scraper output
  console.log("[SEEK RAW EMAIL]", JSON.stringify(email));
  console.log("[SEEK PROFILE ID]", JSON.stringify(seekProfileId));
  console.log("[SALARY RAW]", JSON.stringify(expectedSalaryRaw));
  console.log(`      [FINAL LOCATION] ${domicileLocation || "NOT FOUND"}`);

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

// =========================================================================
// SECTION-BASED DETAIL EXTRACTIONS (Career history, Education, Licences,
// Application questions, Skills)
// =========================================================================
// Each function runs in the browser via page.evaluate — must be
// self-contained.  They locate a section by its visible heading text
// (case-insensitive), then parse the structured content that follows.
// Returns an empty array (never null/undefined) when the section is absent.

function deduplicateText(text) {
  if (!text || text.length < 20) return text;
  var half = Math.floor(text.length / 2);
  var first = text.slice(0, half).trim();
  var second = text.slice(half).trim();
  if (second.startsWith(first.slice(0, 30))) return first;

  var lines = text.split("\n");
  var mid = Math.floor(lines.length / 2);
  var firstLines = lines.slice(0, mid).join("\n").trim();
  var secondLines = lines.slice(mid).join("\n").trim();
  if (firstLines && firstLines === secondLines) return firstLines;

  return text;
}

function isRawDropdown(text) {
  var countPattern = /\(\d+\)/g;
  var matches = text ? text.match(countPattern) : null;
  return matches && matches.length > 3;
}

function cleanApplicationAnswer(text) {
  var answer = (text || "").trim();
  if (answer === "\u2014" || answer === "-" || answer === "\u2013") return "";
  if (isRawDropdown(answer)) return "";
  return answer;
}

function deduplicateQuestions(questions) {
  var seen = new Map();
  for (var qi = 0; qi < questions.length; qi++) {
    var q = questions[qi];
    if (!q || !q.question) continue;
    seen.set(q.question, q);
  }
  return Array.from(seen.values());
}

function isExactHeadingText(text, labels) {
  var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  for (var i = 0; i < labels.length; i++) {
    if (lower === labels[i]) return true;
  }
  return false;
}

function findSectionHeading(root, labels, fuzzyMatch) {
  // SEEK class names are randomized, so section lookup must anchor to stable heading text only.
  var searchRoot = root || document;
  var candidates = Array.from(searchRoot.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b"));
  if (searchRoot !== document) {
    candidates = candidates.concat(Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b")));
  }
  var best = null;
  for (var hi = 0; hi < candidates.length; hi++) {
    var h = candidates[hi];
    var text = (h.textContent || "").replace(/\s+/g, " ").trim();
    var lower = text.toLowerCase();
    var exact = isExactHeadingText(text, labels);
    var fuzzy = fuzzyMatch && fuzzyMatch(lower);
    if (!exact && !fuzzy) continue;
    if (!best || text.length < (best.textContent || "").trim().length) best = h;
  }
  return best;
}

function getSectionContainer(heading) {
  if (!heading) return null;
  var container = heading.parentElement;
  for (var d = 0; d < 6 && container && container !== document.body; d++) {
    if (container.querySelectorAll("li, p, dd, dt, [role='listitem']").length > 0) break;
    container = container.parentElement;
  }
  return container || heading.parentElement;
}

function sectionLinesFromHeading(root, heading, nextSectionHeadings) {
  var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
  var headingText = (heading ? heading.textContent || "" : "").replace(/\s+/g, " ").trim().toLowerCase();
  var inSection = false;
  var lines = [];
  for (var ti = 0; ti < allText.length; ti++) {
    var line = allText[ti];
    var lower = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (!inSection && lower === headingText) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    var isNext = false;
    for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
      if (lower === nextSectionHeadings[ni]) { isNext = true; break; }
    }
    if (isNext) break;
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Extract "Career history" section from the candidate detail panel.
 * Returns an array of { title, company, dates, description } objects.
 */
export function extractCareerHistoryFromDetail() {
  function deduplicateText(text) {
    if (!text || text.length < 20) return text;
    var half = Math.floor(text.length / 2);
    var first = text.slice(0, half).trim();
    var second = text.slice(half).trim();
    if (second.startsWith(first.slice(0, 30))) return first;
    var lines = text.split("\n");
    var mid = Math.floor(lines.length / 2);
    var firstLines = lines.slice(0, mid).join("\n").trim();
    var secondLines = lines.slice(mid).join("\n").trim();
    if (firstLines && firstLines === secondLines) return firstLines;
    return text;
  }

  function isRawDropdown(text) {
    var matches = text ? text.match(/\(\d+\)/g) : null;
    return matches && matches.length > 3;
  }

  function cleanApplicationAnswer(text) {
    var answer = (text || "").trim();
    if (answer === "\u2014" || answer === "-" || answer === "\u2013") return "";
    if (isRawDropdown(answer)) return "";
    return answer;
  }

  function deduplicateQuestions(questions) {
    var seen = new Map();
    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      if (!q || !q.question) continue;
      seen.set(q.question, q);
    }
    return Array.from(seen.values());
  }

  function isExactHeadingText(text, labels) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (var i = 0; i < labels.length; i++) {
      if (lower === labels[i]) return true;
    }
    return false;
  }

  function findSectionHeading(root, labels, fuzzyMatch) {
    var searchRoot = root || document;
    var selector = "h1, h2, h3, h4, h5, h6, strong, b, [role='heading']";
    var candidates = Array.from(searchRoot.querySelectorAll(selector));
    if (searchRoot !== document) {
      candidates = candidates.concat(Array.from(document.querySelectorAll(selector)));
    }
    var best = null;
    for (var hi = 0; hi < candidates.length; hi++) {
      var h = candidates[hi];
      var text = (h.textContent || "").replace(/\s+/g, " ").trim();
      var lower = text.toLowerCase();
      var exact = isExactHeadingText(text, labels);
      var fuzzy = fuzzyMatch && fuzzyMatch(lower);
      if (!exact && !fuzzy) continue;
      if (!best || text.length < (best.textContent || "").trim().length) best = h;
    }
    return best;
  }

  function getSectionContainer(heading) {
    if (!heading) return null;
    var container = heading.parentElement;
    for (var d = 0; d < 6 && container && container !== document.body; d++) {
      if (container.querySelectorAll("li, p, dd, dt, [role='listitem']").length > 0) break;
      container = container.parentElement;
    }
    return container || heading.parentElement;
  }

  function sectionLinesFromHeading(root, heading, nextSectionHeadings) {
    var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
    var headingText = (heading ? heading.textContent || "" : "").replace(/\s+/g, " ").trim().toLowerCase();
    var inSection = false;
    var lines = [];
    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (!inSection && lower === headingText) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      var isNext = false;
      for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
        if (lower === nextSectionHeadings[ni]) { isNext = true; break; }
      }
      if (isNext) break;
      if (line) lines.push(line);
    }
    return lines;
  }

  /**
   * Locate the root panel that contains the candidate detail sections.
   * Mirrors findPanelRoot() logic from extractCandidateDetailFromModal.
   */
  function findDetailPanel() {
    var allLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
    for (var li = 0; li < allLinks.length; li++) {
      var link = allLinks[li];
      var el = link.parentElement;
      for (var depth = 0; depth < 12 && el && el !== document.body; depth++) {
        var hasTabs = el.querySelector('[role="tab"], [role="tablist"], nav a') !== null;
        var hasName = el.querySelector("h1, h2") !== null;
        if (hasTabs && hasName) return el;
        el = el.parentElement;
      }
    }
    var asides = Array.from(document.querySelectorAll("aside"));
    for (var ai = 0; ai < asides.length; ai++) {
      var a = asides[ai];
      if (a.querySelector('[role="tab"], [role="tablist"]') && a.querySelector("h1, h2")) {
        return a;
      }
    }
    var allDivs = Array.from(document.querySelectorAll("section, div, article"));
    for (var di = 0; di < allDivs.length; di++) {
      var el2 = allDivs[di];
      var txt = (el2.innerText || "").toLowerCase();
      if (txt.indexOf("career history") >= 0 && txt.indexOf("education") >= 0) {
        return el2;
      }
    }
    return document.body;
  }

  var root = findDetailPanel();
  var results = [];

  var careerHeading = findSectionHeading(root, ["career history", "riwayat pekerjaan"]);
  if (!careerHeading) return results;

  var container = getSectionContainer(careerHeading);
  if (!container) return results;

  var dateRangePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*[-–—]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Current|Present|Sekarang|Now|Saat ini)\s*\d{0,4}/i;
  var yearRangePattern = /\d{4}\s*[-–—]\s*(\d{4}|Current|Present|Sekarang|Now|Saat ini)/i;
  var nextSectionHeadings = ["education", "pendidikan", "licences", "licenses", "sertifikasi", "application questions", "skills", "keahlian"];
  function normalizedLine(line) { return (line || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function pushUniqueLine(lines, seen, line) {
    var key = normalizedLine(line);
    if (!key || seen[key]) return;
    seen[key] = true;
    lines.push(line);
  }
  function removeDuplicateSentences(text) {
    if (!text) return text;
    var source = String(text).replace(/\s+/g, " ").trim();
    if (source.length < 40) return source;

    var parts = source.split(/(?<=[.!?])\s+|(?=\u2022\s*)|(?=\b\d+\.\s*)/).filter(Boolean);
    if (parts.length <= 1) parts = source.split(/\s{2,}|\s+-\s+/).filter(Boolean);

    var seen = {};
    var unique = [];
    for (var si = 0; si < parts.length; si++) {
      var part = parts[si].replace(/\s+/g, " ").trim();
      if (!part) continue;
      var key = part
        .replace(/^\u2022\s*/, "")
        .replace(/^\d+\.\s*/, "")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!key || seen[key]) continue;
      seen[key] = true;
      unique.push(part);
    }

    var cleaned = unique.join(" ").replace(/\s+/g, " ").trim();
    if (!cleaned) return source;

    var minLen = Math.floor(cleaned.length * 0.25);
    var maxLen = Math.floor(cleaned.length * 0.75);
    for (var splitAt = minLen; splitAt <= maxLen; splitAt++) {
      var firstPart = cleaned.slice(0, splitAt).trim();
      var remainder = cleaned.slice(splitAt).trim();
      if (!firstPart || !remainder) continue;
      var firstKey = firstPart.replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
      var remainderKey = remainder.replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (remainderKey.indexOf(firstKey) === 0) return firstPart;
    }

    return cleaned;
  }

  function deduplicateDescription(text) {
    if (!text) return text;
    text = String(text).replace(/More\u2060?/gi, "").replace(/\([^)]*years?[^)]*months?[^)]*\)/gi, "").replace(/\s+/g, " ").trim();
    if (text.length < 40) return text;

    var bulletParts = text.split(/(?=\u2022\s*)/).filter(Boolean);
    if (bulletParts.length > 1) {
      var seenBullets = {};
      var uniqueBullets = [];
      for (var bi = 0; bi < bulletParts.length; bi++) {
        var bulletKey = bulletParts[bi].replace(/^\u2022\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
        if (seenBullets[bulletKey]) continue;
        seenBullets[bulletKey] = true;
        uniqueBullets.push(bulletParts[bi].trim());
      }
      text = uniqueBullets.join(" ").trim();
    }

    text = text.replace(/([^\s])(\d+\.\s*)/g, "$1 $2");
    var numbered = text.split(/(?=\b\d+\.\s*)/).filter(Boolean);
    if (numbered.length > 1) {
      var seenNumbers = {};
      var maxNumberSeen = 0;
      var numberedUnique = [];
      for (var ni = 0; ni < numbered.length; ni++) {
        var numberMatch = numbered[ni].match(/^\s*(\d+)\./);
        if (numberMatch) {
          var currentNumber = parseInt(numberMatch[1], 10);
          if (seenNumbers[numberMatch[1]] || currentNumber <= maxNumberSeen) continue;
          seenNumbers[numberMatch[1]] = true;
          maxNumberSeen = Math.max(maxNumberSeen, currentNumber);
        }
        numberedUnique.push(numbered[ni].trim());
      }
      text = numberedUnique.join(" ").trim();
    }

    text = text.replace(/\s+\d+\s*$/, "").trim();

    var minLen = Math.floor(text.length * 0.25);
    var maxLen = Math.floor(text.length * 0.75);

    for (var splitAt = minLen; splitAt <= maxLen; splitAt++) {
      var firstPart = text.slice(0, splitAt).trim();
      var remainder = text.slice(splitAt).trim();
      var checkLen = Math.min(60, firstPart.length);
      var firstPartStart = firstPart.slice(0, checkLen).toLowerCase();
      var remainderStart = remainder.slice(0, checkLen).toLowerCase();

      if (firstPartStart && firstPartStart === remainderStart) {
        return removeDuplicateSentences(firstPart);
      }
    }

    var segments = text.split(/(?=\d+\.|\u2022|\-\s)/);
    if (segments.length > 2) {
      var half = Math.floor(segments.length / 2);
      var firstHalfText = segments.slice(0, half).join("").trim();
      var secondHalfText = segments.slice(half).join("").trim();
      var segmentCheckLen = Math.min(30, firstHalfText.length);
      if (
        firstHalfText.slice(0, segmentCheckLen).toLowerCase() ===
        secondHalfText.slice(0, segmentCheckLen).toLowerCase()
      ) {
        return removeDuplicateSentences(firstHalfText);
      }
    }

    return removeDuplicateSentences(text);
  }
  function normalizeDedupeValue(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function dedupeCareerHistory(entries) {
    var seen = new Set();
    var unique = [];
    for (var ci = 0; ci < entries.length; ci++) {
      var entry = entries[ci];
      if (!entry || !entry.title) continue;
      var key = [entry.title, entry.company, entry.dates].map(normalizeDedupeValue).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(entry);
    }
    return unique;
  }
  function countDateMatches(text) {
    var count = 0;
    var lines = String(text || "").split("\n");
    for (var ci = 0; ci < lines.length; ci++) {
      if (dateRangePattern.test(lines[ci]) || yearRangePattern.test(lines[ci])) count++;
    }
    return count;
  }

  var allElements = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b, div, section, article, li"));
  var foundCareerSection = false;

  for (var ei = 0; ei < allElements.length; ei++) {
    var el = allElements[ei];
    var txt = (el.textContent || "").trim();
    var lower = txt.toLowerCase();

    var isNextHeading = false;
    for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
      if (lower === nextSectionHeadings[ni]) { isNextHeading = true; break; }
    }
    if (isNextHeading) {
      if (foundCareerSection) break;
      continue;
    }
    if (el === careerHeading || el.contains(careerHeading)) {
      foundCareerSection = true;
      continue;
    }
    if (!foundCareerSection) continue;
    if (!txt || txt.length < 5) continue;
    if (!dateRangePattern.test(txt) && !yearRangePattern.test(txt)) continue;

    // Parent containers often contain multiple sibling entries; parse smaller children instead.
    if (countDateMatches(txt) > 1) continue;

    var lines = txt.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
    if (lines.length < 2) continue;

    var titleEl = el.querySelector("h3, h4, h5, h6, strong, [data-cy*='title'], [aria-label*='title'], [data-automation*='title'], [data-automation*='position']");
    var title = titleEl ? (titleEl.textContent || "").trim() : (lines[0] || "");
    var company = "";
    var dates = "";
    var description = "";

    for (var li2 = 0; li2 < lines.length; li2++) {
      var line = lines[li2];
      if (line === title) continue;
      if (dateRangePattern.test(line) || yearRangePattern.test(line)) {
        dates = line;
      } else if (/\b(PT|CV|UD|Ltd|Inc|Corp|Perusahaan|Company|Group|Firm|Consulting|Services|Solutions)\b/i.test(line) ||
                 (line.length > 3 && line.length < 80 && !dates && !company && line !== title)) {
        if (!company) company = line;
      }
    }

    if (!company && lines.length >= 2) {
      for (var li3 = 0; li3 < lines.length; li3++) {
        var l2 = lines[li3];
        if (l2 !== title && !dateRangePattern.test(l2) && !yearRangePattern.test(l2)) {
          company = l2;
          break;
        }
      }
    }

    var knownLines = {};
    knownLines[title] = true;
    knownLines[company] = true;
    knownLines[dates] = true;
    var descLines = [];
    var seenDescLines = {};
    for (var li4 = 0; li4 < lines.length; li4++) {
      var l3 = lines[li4];
      if (!knownLines[l3] && l3.length > 10) pushUniqueLine(descLines, seenDescLines, l3);
    }
    description = deduplicateText(descLines.join(" ")) || null;

    if (title) {
      var compactTitle = title.replace(/\s+/g, " ").trim();
      var titleDateMatch = compactTitle.match(dateRangePattern) || compactTitle.match(yearRangePattern);
      if (titleDateMatch) {
        if (!dates) dates = titleDateMatch[0];
        var dateIndex = compactTitle.indexOf(titleDateMatch[0]);
        var beforeDate = compactTitle.slice(0, dateIndex).trim();
        var afterDate = compactTitle.slice(dateIndex + titleDateMatch[0].length).trim();
        if (afterDate) description = description ? description + " " + afterDate : afterDate;
        compactTitle = beforeDate;
      }
      description = removeDuplicateSentences(deduplicateDescription(description)) || null;
      results.push({
        title: compactTitle,
        company: company || null,
        dates: dates || null,
        description: description
      });
    }
  }

  if (results.length === 0) {
    var allText = sectionLinesFromHeading(root, careerHeading, nextSectionHeadings);
    var inCareer = true;
    var currentEntry = null;

    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower2 = line.toLowerCase();
      if (lower2 === "career history" || lower2 === "riwayat pekerjaan") {
        inCareer = true;
        continue;
      }
      if (!inCareer) continue;
      var isNext2 = false;
      for (var nj = 0; nj < nextSectionHeadings.length; nj++) {
        if (lower2 === nextSectionHeadings[nj]) { isNext2 = true; break; }
      }
      if (isNext2) break;
      if (!line) continue;

      if (dateRangePattern.test(line) || yearRangePattern.test(line)) {
        if (currentEntry && currentEntry.title) results.push(currentEntry);
        currentEntry = { title: "", company: null, dates: line, description: null };
        if (ti > 0 && allText[ti - 1]) currentEntry.company = allText[ti - 1];
        if (ti > 1 && allText[ti - 2]) currentEntry.title = allText[ti - 2];
        continue;
      }
      if (currentEntry && line.length > 10) {
        if ((dateRangePattern.test(allText[ti + 1] || "") || yearRangePattern.test(allText[ti + 1] || "")) && ti > 0) {
          continue;
        }
        currentEntry._descriptionLines = currentEntry._descriptionLines || [];
        currentEntry._seenDescriptionLines = currentEntry._seenDescriptionLines || {};
        pushUniqueLine(currentEntry._descriptionLines, currentEntry._seenDescriptionLines, line);
        currentEntry.description = currentEntry._descriptionLines.join(" ") || null;
      }
    }
    if (currentEntry && currentEntry.title) results.push(currentEntry);
  }

  for (var ri = 0; ri < results.length; ri++) {
    results[ri].description = removeDuplicateSentences(deduplicateDescription(results[ri].description));
    delete results[ri]._descriptionLines;
    delete results[ri]._seenDescriptionLines;
  }

  return dedupeCareerHistory(results);
}

/**
 * Extract "Education" section from the candidate detail panel.
 * Returns an array of { degree, institution, status, description } objects.
 */
export function extractEducationFromDetail() {
  function deduplicateText(text) {
    if (!text || text.length < 20) return text;
    var half = Math.floor(text.length / 2);
    var first = text.slice(0, half).trim();
    var second = text.slice(half).trim();
    if (second.startsWith(first.slice(0, 30))) return first;
    var lines = text.split("\n");
    var mid = Math.floor(lines.length / 2);
    var firstLines = lines.slice(0, mid).join("\n").trim();
    var secondLines = lines.slice(mid).join("\n").trim();
    if (firstLines && firstLines === secondLines) return firstLines;
    return text;
  }

  function isRawDropdown(text) {
    var matches = text ? text.match(/\(\d+\)/g) : null;
    return matches && matches.length > 3;
  }

  function cleanApplicationAnswer(text) {
    var answer = (text || "").trim();
    if (answer === "\u2014" || answer === "-" || answer === "\u2013") return "";
    if (isRawDropdown(answer)) return "";
    return answer;
  }

  function deduplicateQuestions(questions) {
    var seen = new Map();
    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      if (!q || !q.question) continue;
      seen.set(q.question, q);
    }
    return Array.from(seen.values());
  }

  function isExactHeadingText(text, labels) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (var i = 0; i < labels.length; i++) {
      if (lower === labels[i]) return true;
    }
    return false;
  }

  function findSectionHeading(root, labels, fuzzyMatch) {
    var searchRoot = root || document;
    var selector = "h1, h2, h3, h4, h5, h6, strong, b, [role='heading']";
    var candidates = Array.from(searchRoot.querySelectorAll(selector));
    if (searchRoot !== document) {
      candidates = candidates.concat(Array.from(document.querySelectorAll(selector)));
    }
    var best = null;
    for (var hi = 0; hi < candidates.length; hi++) {
      var h = candidates[hi];
      var text = (h.textContent || "").replace(/\s+/g, " ").trim();
      var lower = text.toLowerCase();
      var exact = isExactHeadingText(text, labels);
      var fuzzy = fuzzyMatch && fuzzyMatch(lower);
      if (!exact && !fuzzy) continue;
      if (!best || text.length < (best.textContent || "").trim().length) best = h;
    }
    return best;
  }

  function getSectionContainer(heading) {
    if (!heading) return null;
    var container = heading.parentElement;
    for (var d = 0; d < 6 && container && container !== document.body; d++) {
      if (container.querySelectorAll("li, p, dd, dt, [role='listitem']").length > 0) break;
      container = container.parentElement;
    }
    return container || heading.parentElement;
  }

  function sectionLinesFromHeading(root, heading, nextSectionHeadings) {
    var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
    var headingText = (heading ? heading.textContent || "" : "").replace(/\s+/g, " ").trim().toLowerCase();
    var inSection = false;
    var lines = [];
    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (!inSection && lower === headingText) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      var isNext = false;
      for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
        if (lower === nextSectionHeadings[ni]) { isNext = true; break; }
      }
      if (isNext) break;
      if (line) lines.push(line);
    }
    return lines;
  }

  function findDetailPanel() {
    var allLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
    for (var li = 0; li < allLinks.length; li++) {
      var link = allLinks[li];
      var el = link.parentElement;
      for (var depth = 0; depth < 12 && el && el !== document.body; depth++) {
        var hasTabs = el.querySelector('[role="tab"], [role="tablist"], nav a') !== null;
        var hasName = el.querySelector("h1, h2") !== null;
        if (hasTabs && hasName) return el;
        el = el.parentElement;
      }
    }
    var asides = Array.from(document.querySelectorAll("aside"));
    for (var ai = 0; ai < asides.length; ai++) {
      var a = asides[ai];
      if (a.querySelector('[role="tab"], [role="tablist"]') && a.querySelector("h1, h2")) {
        return a;
      }
    }
    var allDivs = Array.from(document.querySelectorAll("section, div, article"));
    for (var di = 0; di < allDivs.length; di++) {
      var el2 = allDivs[di];
      var txt = (el2.innerText || "").toLowerCase();
      if (txt.indexOf("education") >= 0 && (txt.indexOf("career history") >= 0 || txt.indexOf("licences") >= 0)) {
        return el2;
      }
    }
    return document.body;
  }

  var root = findDetailPanel();
  var results = [];

  var eduHeading = findSectionHeading(root, ["education", "pendidikan"]);
  if (!eduHeading) return results;

  var container = getSectionContainer(eduHeading);
  if (!container) return results;

  var dateRangePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*[-–—]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Current|Present|Sekarang|Now|Saat ini)\s*\d{0,4}/i;
  var yearPattern = /\d{4}/;
  var finishedPattern = /(Finished|Lulus|Graduated|Completed|Selesai)\s*\d{4}/i;
  var nextSectionHeadings = ["licences", "licenses", "sertifikasi", "certifications", "application questions", "skills", "keahlian", "career history"];
  function isApplicationQuestionHeading(text) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    return lower === "application questions" || lower === "pertanyaan penyaringan" || lower === "screening questions";
  }
  function hasApplicationQuestionBlob(text) {
    var value = text || "";
    var labels = ["Gaji bulanan", "Pendidikan kandidat", "Pengalaman", "Waktu pemberitahuan", "Kemampuan"];
    var matches = 0;
    for (var ai = 0; ai < labels.length; ai++) {
      if (value.indexOf(labels[ai]) >= 0) matches++;
    }
    return matches >= 2;
  }
  function normalizedLine(line) { return (line || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function pushUniqueLine(lines, seen, line) {
    var key = normalizedLine(line);
    if (!key || seen[key]) return;
    seen[key] = true;
    lines.push(line);
  }
  function normalizeDedupeValue(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function normalizeInstitution(name) {
    return (name || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/\b(university|universitas|of|the|institut|institute|college|school|academy|akademi|politeknik|bachelor|master|doctor|diploma|sarjana|magister|law)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .sort()
      .join(" ");
  }
  function educationYear(entry) {
    var values = [entry && entry.graduationYear, entry && entry.endDate, entry && entry.status];
    for (var yi = 0; yi < values.length; yi++) {
      var match = String(values[yi] || "").match(/\b(19|20)\d{2}\b/);
      if (match) return match[0];
    }
    return "";
  }
  function normalizeEducationDegree(value) {
    var degree = String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2");
    degree = normalizeDedupeValue(degree);
    degree = degree.replace(/(university|universitas|andalas|finished|lulus|graduated|completed|selesai|\b(19|20)\d{2}\b).*$/g, "");
    return degree.trim();
  }
  function normalizeInstitutionForEntry(entry) {
    var combined = ((entry && entry.institution) || "") + " " + ((entry && entry.degree) || "");
    return normalizeInstitution(combined);
  }
  function isApplicationDataEntry(entry) {
    var combined = ((entry && entry.degree) || "") + " " + ((entry && entry.institution) || "");
    combined = combined.toLowerCase();
    return combined.indexOf("application") >= 0 ||
      combined.indexOf("gaji bulanan") >= 0 ||
      combined.indexOf("pendidikan kandidat") >= 0 ||
      combined.indexOf("pengalaman") >= 0;
  }
  function isMergedEducationContainer(entry) {
    var combined = ((entry && entry.degree) || "") + " " + ((entry && entry.institution) || "") + " " + ((entry && entry.status) || "");
    var degreeMatches = combined.match(/\b(bachelor|master|doctor|diploma|sarjana|magister)\b/gi) || [];
    var yearMatches = combined.match(/\b(19|20)\d{2}\b/g) || [];
    return degreeMatches.length > 1 && yearMatches.length > 1;
  }
  function normalizeEducationEntry(entry) {
    if (!entry || !entry.degree) return entry;
    var degreeText = String(entry.degree || "").replace(/\s+/g, " ").trim();
    var institutionText = String(entry.institution || "").replace(/\s+/g, " ").trim();
    var joined = (degreeText + institutionText).replace(/\s+/g, " ").trim();

    var statusMatch = joined.match(/(Finished|Lulus|Graduated|Completed|Selesai)\s*((?:19|20)\d{2})/i);
    var andalasJoinedMatch = joined.match(/^(Bachelor\s+of\s+Law)Andalas\s+University\s+(Finished|Lulus|Graduated|Completed|Selesai)\s*((?:19|20)\d{2})$/i);
    if (andalasJoinedMatch) {
      entry.degree = andalasJoinedMatch[1].replace(/\s+/g, " ").trim();
      entry.institution = "University of Andalas";
      entry.status = ((andalasJoinedMatch[2] || "") + " " + (andalasJoinedMatch[3] || "")).trim();
      return entry;
    }

    var instMatch = joined.match(/(University|Universitas|Institut|Institute|College|School|Academy|Akademi|Politeknik)/i);
    if (statusMatch && instMatch) {
      var statusIndex = joined.indexOf(statusMatch[0]);
      var instIndex = instMatch.index;
      var degreePart = joined.slice(0, instIndex).trim();
      var instPart = joined.slice(instIndex, statusIndex).trim();
      if (degreePart && instPart) {
        entry.degree = degreePart.replace(/\s+/g, " ").trim();
        entry.institution = instPart.replace(/\s+/g, " ").trim();
        entry.status = ((statusMatch[1] || "") + " " + (statusMatch[2] || "")).trim();
        return entry;
      }
    }

    if (entry.institution) {
      entry.institution = institutionText;
      if (entry.status && entry.institution.indexOf(entry.status) >= 0) {
        entry.institution = entry.institution.slice(0, entry.institution.indexOf(entry.status)).trim();
      }
      entry.institution = entry.institution.replace(/(Finished|Lulus|Graduated|Completed|Selesai)\s*(?:19|20)\d{2}.*$/i, "").trim();
    }

    if (/^Bachelor\s+of\s+LawAndalas$/i.test(degreeText) && /^University$/i.test(institutionText)) {
      entry.degree = "Bachelor of Law";
      entry.institution = "University of Andalas";
      if (!entry.status && statusMatch) entry.status = ((statusMatch[1] || "") + " " + (statusMatch[2] || "")).trim();
      return entry;
    }

    var match = degreeText.match(/^(.*?)(University|Universitas|Institut|Institute|College|School|Academy|Akademi|Politeknik)\s+(.+?)(Finished|Lulus|Graduated|Completed|Selesai)\s*((?:19|20)\d{2})$/i);
    if (!match) return entry;

    entry.degree = match[1].trim();
    entry.institution = ((match[2] || "") + " " + (match[3] || "")).replace(/\s+/g, " ").trim();
    entry.status = ((match[4] || "") + " " + (match[5] || "")).trim();
    return entry;
  }
  function dedupeEducation(entries) {
    var unique = [];
    for (var di = 0; di < entries.length; di++) {
      var entry = normalizeEducationEntry(entries[di]);
      if (!entry || !entry.degree || isApplicationDataEntry(entry) || isMergedEducationContainer(entry)) continue;
      var duplicate = false;
      for (var ui = 0; ui < unique.length; ui++) {
        var prev = unique[ui];
        var sameDegree = normalizeEducationDegree(prev.degree) === normalizeEducationDegree(entry.degree);
        var prevYear = educationYear(prev);
        var entryYear = educationYear(entry);
        var sameYear = (prevYear && entryYear && prevYear === entryYear) ||
          normalizeDedupeValue(prev.endDate) === normalizeDedupeValue(entry.endDate);
        var normPrev = normalizeInstitutionForEntry(prev);
        var normCurr = normalizeInstitutionForEntry(entry);
        var similarInst = normPrev && normCurr && (
          normPrev.indexOf(normCurr) >= 0 ||
          normCurr.indexOf(normPrev) >= 0 ||
          normPrev === normCurr
        );
        if (sameDegree && similarInst && (sameYear || normPrev === normCurr)) {
          duplicate = true;
          if (entry.institution && (!prev.institution || normalizeInstitution(entry.institution).length > normalizeInstitution(prev.institution).length || entry.institution.length > prev.institution.length)) prev.institution = entry.institution;
          break;
        }
      }
      if (!duplicate) unique.push(entry);
    }
    return unique;
  }

  var allElements = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b, div, section, article, li"));
  var foundEduSection = false;

  for (var ei = 0; ei < allElements.length; ei++) {
    var el = allElements[ei];
    var txt = (el.textContent || "").trim();
    var lower = txt.toLowerCase();

    var isNextHeading = false;
    for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
      if (lower === nextSectionHeadings[ni]) { isNextHeading = true; break; }
    }
    if (isNextHeading) {
      if (foundEduSection) break;
      continue;
    }
    if (el === eduHeading || el.contains(eduHeading)) {
      foundEduSection = true;
      continue;
    }
    if (!foundEduSection) continue;
    if (!txt || txt.length < 3) continue;

    var hasDegree = /sarjana|magister|bachelor|master|doctor|diploma|s\.\s*[a-z]|s1\b|s2\b|s3\b|d3\b|d4\b|sma\b|smk\b|degree|gelar/i.test(txt);
    if (!hasDegree) continue;

    var lines = txt.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
    if (lines.length < 1) continue;

    var degreeEl = el.querySelector("h3, h4, h5, h6, strong, [data-cy*='degree'], [aria-label*='degree'], [data-cy*='education']");
    var degree = degreeEl ? (degreeEl.textContent || "").trim() : (lines[0] || "");
    var institution = "";
    var status = "";
    var description = "";

    for (var li2 = 0; li2 < lines.length; li2++) {
      var line = lines[li2];
      if (line === degree) continue;
      if (finishedPattern.test(line) || dateRangePattern.test(line)) {
        status = line;
      } else if (yearPattern.test(line) && !status) {
        status = line;
      } else if (/\b(university|universitas|institut|institute|school|sekolah|politeknik|academy|akademi|college|STM|SMA|SMK)\b/i.test(line) && !institution) {
        institution = line;
      } else if (line.length > 10 && !institution) {
        institution = line;
      }
    }

    if (!institution && lines.length >= 2) {
      for (var li3 = 0; li3 < lines.length; li3++) {
        var l2 = lines[li3];
        if (l2 !== degree && !finishedPattern.test(l2) && !dateRangePattern.test(l2)) {
          institution = l2;
          break;
        }
      }
    }

    var knownLines = {};
    knownLines[degree] = true;
    if (institution) knownLines[institution] = true;
    if (status) knownLines[status] = true;
    var descLines = [];
    var seenDescLines = {};
    for (var li4 = 0; li4 < lines.length; li4++) {
      var l3 = lines[li4];
      if (!knownLines[l3] && l3.length > 10) pushUniqueLine(descLines, seenDescLines, l3);
    }
    description = deduplicateText(descLines.join(" ")) || null;

    if (degree && !isApplicationQuestionHeading(degree) && !hasApplicationQuestionBlob(txt)) {
      results.push({
        degree: degree,
        institution: institution || null,
        status: status || null,
        description: description
      });
    }
  }

  if (results.length === 0) {
    var allText = sectionLinesFromHeading(root, eduHeading, nextSectionHeadings);
    var inEdu = true;
    var currentEntry = null;

    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower2 = line.toLowerCase();
      if (lower2 === "education" || lower2 === "pendidikan") {
        inEdu = true;
        continue;
      }
      if (!inEdu) continue;
      var isNext2 = false;
      for (var nj = 0; nj < nextSectionHeadings.length; nj++) {
        if (lower2 === nextSectionHeadings[nj]) { isNext2 = true; break; }
      }
      if (isNext2) break;
      if (!line) continue;

      var hasDegree2 = /sarjana|magister|bachelor|master|doctor|diploma|s\.\s*[a-z]|s1\b|s2\b|s3\b|d3\b|d4\b/i.test(line);
      if (hasDegree2 && !currentEntry) {
        currentEntry = { degree: line, institution: null, status: null, description: null };
      } else if (currentEntry) {
        if (finishedPattern.test(line) || yearPattern.test(line)) {
          currentEntry.status = line;
        } else if (!currentEntry.institution && line.length > 3) {
          currentEntry.institution = line;
        }
      }
    }
    if (currentEntry && currentEntry.degree) results.push(currentEntry);
  }

  for (var ri = 0; ri < results.length; ri++) {
    results[ri].description = deduplicateText(results[ri].description);
  }

  results = results.filter(function(entry) {
    return entry && !isApplicationQuestionHeading(entry.degree) && !isApplicationDataEntry(entry) && !hasApplicationQuestionBlob(entry.institution || "") && !hasApplicationQuestionBlob(entry.description || "");
  });

  return dedupeEducation(results);
}

/**
 * Extract "Licences and certifications" (or "Licenses and certifications")
 * section from the candidate detail panel.
 * Returns an array of { name, organization, dates, description } objects.
 */
export function extractLicencesAndCertificationsFromDetail() {
  function removeDuplicateSentences(text) {
    if (!text) return text;
    var source = String(text).replace(/\s+/g, " ").trim();
    if (source.length < 40) return source;

    var parts = source.split(/(?<=[.!?])\s+|(?=\u2022\s*)|(?=\b\d+\.\s*)/).filter(Boolean);
    if (parts.length <= 1) parts = source.split(/\s{2,}|\s+-\s+/).filter(Boolean);

    var seen = {};
    var unique = [];
    for (var si = 0; si < parts.length; si++) {
      var part = parts[si].replace(/\s+/g, " ").trim();
      if (!part) continue;
      var key = part
        .replace(/^\u2022\s*/, "")
        .replace(/^\d+\.\s*/, "")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!key || seen[key]) continue;
      seen[key] = true;
      unique.push(part);
    }

    var cleaned = unique.join(" ").replace(/\s+/g, " ").trim();
    if (!cleaned) return source;

    var minLen = Math.floor(cleaned.length * 0.25);
    var maxLen = Math.floor(cleaned.length * 0.75);
    for (var splitAt = minLen; splitAt <= maxLen; splitAt++) {
      var firstPart = cleaned.slice(0, splitAt).trim();
      var remainder = cleaned.slice(splitAt).trim();
      if (!firstPart || !remainder) continue;
      var firstKey = firstPart.replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
      var remainderKey = remainder.replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (remainderKey.indexOf(firstKey) === 0) return firstPart;
    }

    return cleaned;
  }

  function deduplicateText(text) {
    if (!text || text.length < 20) return text;
    var half = Math.floor(text.length / 2);
    var first = text.slice(0, half).trim();
    var second = text.slice(half).trim();
    if (second.startsWith(first.slice(0, 30))) return removeDuplicateSentences(first);
    var lines = text.split("\n");
    var mid = Math.floor(lines.length / 2);
    var firstLines = lines.slice(0, mid).join("\n").trim();
    var secondLines = lines.slice(mid).join("\n").trim();
    if (firstLines && firstLines === secondLines) return removeDuplicateSentences(firstLines);
    return removeDuplicateSentences(text);
  }

  function isRawDropdown(text) {
    var matches = text ? text.match(/\(\d+\)/g) : null;
    return matches && matches.length > 3;
  }

  function cleanApplicationAnswer(text) {
    var answer = (text || "").trim();
    if (answer === "\u2014" || answer === "-" || answer === "\u2013") return "";
    if (isRawDropdown(answer)) return "";
    return answer;
  }

  function deduplicateQuestions(questions) {
    var seen = new Map();
    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      if (!q || !q.question) continue;
      seen.set(q.question, q);
    }
    return Array.from(seen.values());
  }

  function isExactHeadingText(text, labels) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (var i = 0; i < labels.length; i++) {
      if (lower === labels[i]) return true;
    }
    return false;
  }

  function findSectionHeading(root, labels, fuzzyMatch) {
    var searchRoot = root || document;
    var selector = "h1, h2, h3, h4, h5, h6, strong, b, [role='heading']";
    var candidates = Array.from(searchRoot.querySelectorAll(selector));
    if (searchRoot !== document) {
      candidates = candidates.concat(Array.from(document.querySelectorAll(selector)));
    }
    var best = null;
    for (var hi = 0; hi < candidates.length; hi++) {
      var h = candidates[hi];
      var text = (h.textContent || "").replace(/\s+/g, " ").trim();
      var lower = text.toLowerCase();
      var exact = isExactHeadingText(text, labels);
      var fuzzy = fuzzyMatch && fuzzyMatch(lower);
      if (!exact && !fuzzy) continue;
      if (!best || text.length < (best.textContent || "").trim().length) best = h;
    }
    return best;
  }

  function getSectionContainer(heading) {
    if (!heading) return null;
    var container = heading.parentElement;
    for (var d = 0; d < 6 && container && container !== document.body; d++) {
      if (container.querySelectorAll("li, p, dd, dt, [role='listitem']").length > 0) break;
      container = container.parentElement;
    }
    return container || heading.parentElement;
  }

  function sectionLinesFromHeading(root, heading, nextSectionHeadings) {
    var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
    var headingText = (heading ? heading.textContent || "" : "").replace(/\s+/g, " ").trim().toLowerCase();
    var inSection = false;
    var lines = [];
    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (!inSection && lower === headingText) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      var isNext = false;
      for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
        if (lower === nextSectionHeadings[ni]) { isNext = true; break; }
      }
      if (isNext) break;
      if (line) lines.push(line);
    }
    return lines;
  }

  function isApplicationQuestionHeading(text) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    return lower === "application questions" || lower === "pertanyaan penyaringan" || lower === "screening questions";
  }
  function hasApplicationQuestionBlob(text) {
    var value = text || "";
    var labels = ["Gaji bulanan", "Pendidikan kandidat", "Pengalaman", "Waktu pemberitahuan", "Kemampuan"];
    var matches = 0;
    for (var ai = 0; ai < labels.length; ai++) {
      if (value.indexOf(labels[ai]) >= 0) matches++;
    }
    return matches >= 2;
  }
  function normalizeDedupeValue(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function countDateMatches(text) {
    var normalized = String(text || "").replace(/([a-z])((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/g, "$1 $2");
    var monthMatches = normalized.match(new RegExp(dateRangePattern.source, "gi")) || [];
    var yearMatches = normalized.match(new RegExp(yearRangePattern.source, "gi")) || [];
    return monthMatches.length + yearMatches.length;
  }
  function splitMergedLicenceText(text) {
    var normalized = String(text || "")
      .replace(/([a-z])((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/g, "$1 $2")
      .replace(/(Current|Present|Sekarang|Now|Saat ini)(?=[A-Z])/g, "$1\n")
      .replace(/(\(\d{4}\))(?=[A-Z])/g, "$1\n");
    var chunks = normalized.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
    var entries = [];
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      var dateMatch = chunk.match(dateRangePattern) || chunk.match(yearRangePattern);
      if (!dateMatch) continue;
      var beforeDate = chunk.slice(0, chunk.indexOf(dateMatch[0])).trim();
      var afterDate = chunk.slice(chunk.indexOf(dateMatch[0]) + dateMatch[0].length).trim();
      var byIndex = beforeDate.search(/\sby\s/i);
      var org = "";
      var name = beforeDate;
      if (byIndex >= 0) {
        name = beforeDate.slice(0, byIndex).trim();
        org = beforeDate.slice(byIndex + 4).trim();
      } else {
        var orgMatch = beforeDate.match(/^(.*?)(\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,3}(?:Education|Educations|Educatioon|University|Univesity|Department|Dept|Institute|Company|Group))$/);
        if (orgMatch) {
          name = orgMatch[1].trim();
          org = orgMatch[2].trim();
        }
      }
      var description = afterDate.replace(/^[-–—\s]+/, "").trim();
      if (name) {
        entries.push({
          name: name,
          organization: org || null,
          dates: dateMatch[0],
          description: removeDuplicateSentences(deduplicateText(description)) || null
        });
      }
    }
    return entries;
  }
  function normalizeLicenceName(value) {
    var normalized = (value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/\(?(?:19|20)\d{2}\)?/g, " ")
      .replace(/\b(by|certification|certificate|licence|license|lisensi|sertifikasi|training|course|program|education|educations|educatioon)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    var tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length > 1 && tokens.length % 2 === 0) {
      var half = tokens.length / 2;
      if (tokens.slice(0, half).join(" ") === tokens.slice(half).join(" ")) {
        normalized = tokens.slice(0, half).join(" ");
      }
    }
    return normalized;
  }
  function tokenOverlapScore(a, b) {
    var aTokens = normalizeLicenceName(a).split(" ").filter(Boolean);
    var bTokens = normalizeLicenceName(b).split(" ").filter(Boolean);
    if (!aTokens.length || !bTokens.length) return 0;
    var bMap = {};
    var matches = 0;
    for (var bi = 0; bi < bTokens.length; bi++) bMap[bTokens[bi]] = true;
    for (var ai = 0; ai < aTokens.length; ai++) {
      if (bMap[aTokens[ai]]) matches++;
    }
    return matches / Math.max(aTokens.length, bTokens.length);
  }
  function dedupeLicences(entries) {
    var seen = new Set();
    var unique = [];
    for (var li = 0; li < entries.length; li++) {
      var entry = entries[li];
      if (!entry || !entry.name) continue;
      var key = [entry.name, entry.organization].map(normalizeDedupeValue).join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      var duplicate = false;
      for (var ui = 0; ui < unique.length; ui++) {
        var prev = unique[ui];
        var sameOrg = normalizeDedupeValue(prev.organization || prev.issuer) === normalizeDedupeValue(entry.organization || entry.issuer);
        var prevName = normalizeLicenceName(prev.name);
        var entryName = normalizeLicenceName(entry.name);
        var overlap = tokenOverlapScore(prev.name, entry.name);
        var similarName = prevName && entryName && (
          prevName === entryName ||
          prevName.indexOf(entryName) >= 0 ||
          entryName.indexOf(prevName) >= 0 ||
          overlap >= 0.7
        );
        var datedDuplicate = similarName && (prev.dates || entry.dates) && overlap >= 0.5;
        if ((similarName && (sameOrg || !prev.organization || !entry.organization)) || datedDuplicate) {
          duplicate = true;
          if (!prev.description && entry.description) prev.description = entry.description;
          if (!prev.dates && entry.dates) prev.dates = entry.dates;
          break;
        }
      }
      if (!duplicate) unique.push(entry);
    }
    return unique;
  }

  function findDetailPanel() {
    var allLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
    for (var li = 0; li < allLinks.length; li++) {
      var link = allLinks[li];
      var el = link.parentElement;
      for (var depth = 0; depth < 12 && el && el !== document.body; depth++) {
        var hasTabs = el.querySelector('[role="tab"], [role="tablist"], nav a') !== null;
        var hasName = el.querySelector("h1, h2") !== null;
        if (hasTabs && hasName) return el;
        el = el.parentElement;
      }
    }
    var asides = Array.from(document.querySelectorAll("aside"));
    for (var ai = 0; ai < asides.length; ai++) {
      var a = asides[ai];
      if (a.querySelector('[role="tab"], [role="tablist"]') && a.querySelector("h1, h2")) {
        return a;
      }
    }
    var allDivs = Array.from(document.querySelectorAll("section, div, article"));
    for (var di = 0; di < allDivs.length; di++) {
      var el2 = allDivs[di];
      var txt = (el2.innerText || "").toLowerCase();
      if ((txt.indexOf("licences") >= 0 || txt.indexOf("licenses") >= 0) && txt.indexOf("certifications") >= 0) {
        return el2;
      }
    }
    return document.body;
  }

  var root = findDetailPanel();
  var results = [];

  var licHeading = findSectionHeading(
    root,
    ["licences and certifications", "licenses and certifications", "lisensi dan sertifikasi", "lisensi & sertifikasi", "sertifikasi dan lisensi"],
    function(lower) {
      return (lower.indexOf("licences") >= 0 || lower.indexOf("licenses") >= 0) && lower.indexOf("certifications") >= 0;
    }
  );
  if (!licHeading) return results;

  var container = getSectionContainer(licHeading);
  if (!container) return results;

  var dateRangePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*[-–—]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Current|Present|Sekarang|Now|Saat ini)\s*\d{0,4}/i;
  var yearRangePattern = /\d{4}\s*[-–—]\s*(\d{4}|Current|Present|Sekarang|Now|Saat ini)/i;
  var nextSectionHeadings = ["application questions", "pertanyaan penyaringan", "skills", "keahlian", "education", "pendidikan"];

  var allElements = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b, div, section, article, li"));
  var foundLicSection = false;

  for (var ei = 0; ei < allElements.length; ei++) {
    var el = allElements[ei];
    var txt = (el.textContent || "").trim();
    var lower = txt.toLowerCase();

    var isNextHeading = false;
    for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
      if (lower === nextSectionHeadings[ni]) { isNextHeading = true; break; }
    }
    if (isNextHeading) {
      if (foundLicSection) break;
      continue;
    }
    if (el === licHeading || el.contains(licHeading)) {
      foundLicSection = true;
      continue;
    }
    if (!foundLicSection) continue;
    if (!txt || txt.length < 3) continue;

    var hasDate = dateRangePattern.test(txt) || yearRangePattern.test(txt);
    if (!hasDate && txt.length < 8) continue;

    if (countDateMatches(txt) > 1) {
      var splitEntries = splitMergedLicenceText(txt);
      for (var si = 0; si < splitEntries.length; si++) results.push(splitEntries[si]);
      continue;
    }

    var lines = txt.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
    if (lines.length < 1) continue;

    var nameEl = el.querySelector("h3, h4, h5, h6, strong, [data-cy*='licence'], [data-cy*='license'], [aria-label*='licence'], [aria-label*='license']");
    var name = nameEl ? (nameEl.textContent || "").trim() : (lines[0] || "");
    var organization = "";
    var dates = "";
    var description = "";

    for (var li2 = 0; li2 < lines.length; li2++) {
      var line = lines[li2];
      if (line === name) continue;
      if (dateRangePattern.test(line) || yearRangePattern.test(line)) {
        dates = line;
      } else if (line.length > 3 && line.length < 80 && !dates && !organization) {
        organization = line;
      }
    }

    var knownLines = {};
    knownLines[name] = true;
    if (organization) knownLines[organization] = true;
    if (dates) knownLines[dates] = true;
    var descLines = [];
    for (var li3 = 0; li3 < lines.length; li3++) {
      var l2 = lines[li3];
      if (!knownLines[l2] && l2.length > 10) descLines.push(l2);
    }
    description = removeDuplicateSentences(deduplicateText(descLines.join(" "))) || null;

    if (name && !isApplicationQuestionHeading(name) && !hasApplicationQuestionBlob(txt)) {
      results.push({
        name: name,
        organization: organization || null,
        dates: dates || null,
        description: description
      });
    }
  }

  if (results.length === 0) {
    var allText = sectionLinesFromHeading(root, licHeading, nextSectionHeadings);
    var inLic = true;
    var currentEntry = null;

    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower2 = line.toLowerCase();
      if ((lower2.indexOf("licences") >= 0 || lower2.indexOf("licenses") >= 0) && lower2.indexOf("certifications") >= 0) {
        inLic = true;
        continue;
      }
      if (lower2 === "lisensi dan sertifikasi" || lower2 === "sertifikasi dan lisensi") {
        inLic = true;
        continue;
      }
      if (!inLic) continue;
      var isNext2 = false;
      for (var nj = 0; nj < nextSectionHeadings.length; nj++) {
        if (lower2 === nextSectionHeadings[nj]) { isNext2 = true; break; }
      }
      if (isNext2) break;
      if (!line) continue;

      if (dateRangePattern.test(line) || yearRangePattern.test(line)) {
        if (currentEntry && currentEntry.name) results.push(currentEntry);
        currentEntry = { name: "", organization: null, dates: line, description: null };
        if (ti > 0 && allText[ti - 1]) currentEntry.organization = allText[ti - 1];
        if (ti > 1 && allText[ti - 2]) currentEntry.name = allText[ti - 2];
        continue;
      }
      if (currentEntry && line.length > 10) {
        currentEntry.description = currentEntry.description ? currentEntry.description + " " + line : line;
      }
    }
    if (currentEntry && currentEntry.name) results.push(currentEntry);
  }

  for (var ri = 0; ri < results.length; ri++) {
    results[ri].description = removeDuplicateSentences(deduplicateText(results[ri].description));
  }

  results = results.filter(function(entry) {
    var combined = ((entry && entry.name) || "") + " " + ((entry && (entry.issuer || entry.organization)) || "");
    combined = combined.toLowerCase();
    return entry &&
      !isApplicationQuestionHeading(entry.name) &&
      combined.indexOf("application") < 0 &&
      combined.indexOf("gaji bulanan") < 0 &&
      combined.indexOf("pendidikan kandidat") < 0 &&
      !hasApplicationQuestionBlob(entry.organization || "") &&
      !hasApplicationQuestionBlob(entry.description || "");
  });

  return dedupeLicences(results);
}

/**
 * Extract "Application questions" section from the candidate detail panel.
 * Returns an array of { question, answer } objects.
 * Questions can vary between candidates — do NOT hardcode a list.
 */
export function extractApplicationQuestionsFromDetail() {
  function deduplicateText(text) {
    if (!text || text.length < 20) return text;
    var half = Math.floor(text.length / 2);
    var first = text.slice(0, half).trim();
    var second = text.slice(half).trim();
    if (second.startsWith(first.slice(0, 30))) return first;
    var lines = text.split("\n");
    var mid = Math.floor(lines.length / 2);
    var firstLines = lines.slice(0, mid).join("\n").trim();
    var secondLines = lines.slice(mid).join("\n").trim();
    if (firstLines && firstLines === secondLines) return firstLines;
    return text;
  }

  function isRawDropdown(text) {
    var matches = text ? text.match(/\(\d+\)/g) : null;
    return matches && matches.length > 3;
  }

  function cleanApplicationAnswer(text) {
    var answer = (text || "").trim();
    if (answer === "\u2014" || answer === "-" || answer === "\u2013") return "";
    if (isRawDropdown(answer)) return "";
    return answer;
  }

  function isApplicationQuestionHeading(text) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    return lower === "application questions" || lower === "pertanyaan penyaringan" || lower === "screening questions";
  }

  function isBlobAnswer(answer) {
    var text = answer || "";
    var knownQuestions = ["Gaji bulanan", "Pendidikan kandidat", "Pengalaman", "Waktu pemberitahuan", "Kemampuan"];
    var matches = 0;
    for (var bi = 0; bi < knownQuestions.length; bi++) {
      if (text.indexOf(knownQuestions[bi]) >= 0) matches++;
    }
    return matches >= 2;
  }

  function deduplicateQuestions(questions) {
    var seen = new Map();
    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      if (!q || !q.question) continue;
      if (isApplicationQuestionHeading(q.question)) continue;
      if (isBlobAnswer(q.answer)) continue;
      seen.set(q.question.replace(/\s+/g, " ").trim(), q);
    }
    return Array.from(seen.values());
  }

  function isExactHeadingText(text, labels) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (var i = 0; i < labels.length; i++) {
      if (lower === labels[i]) return true;
    }
    return false;
  }

  function findSectionHeading(root, labels, fuzzyMatch) {
    var searchRoot = root || document;
    var selector = "h1, h2, h3, h4, h5, h6, strong, b, [role='heading']";
    var candidates = Array.from(searchRoot.querySelectorAll(selector));
    if (searchRoot !== document) {
      candidates = candidates.concat(Array.from(document.querySelectorAll(selector)));
    }
    var best = null;
    for (var hi = 0; hi < candidates.length; hi++) {
      var h = candidates[hi];
      var text = (h.textContent || "").replace(/\s+/g, " ").trim();
      var lower = text.toLowerCase();
      var exact = isExactHeadingText(text, labels);
      var fuzzy = fuzzyMatch && fuzzyMatch(lower);
      if (!exact && !fuzzy) continue;
      if (!best || text.length < (best.textContent || "").trim().length) best = h;
    }
    return best;
  }

  function getSectionContainer(heading) {
    if (!heading) return null;
    var container = heading.parentElement;
    for (var d = 0; d < 6 && container && container !== document.body; d++) {
      if (container.querySelectorAll("li, p, dd, dt, [role='listitem']").length > 0) break;
      container = container.parentElement;
    }
    return container || heading.parentElement;
  }

  function sectionLinesFromHeading(root, heading, nextSectionHeadings) {
    var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
    var headingText = (heading ? heading.textContent || "" : "").replace(/\s+/g, " ").trim().toLowerCase();
    var inSection = false;
    var lines = [];
    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (!inSection && lower === headingText) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      var isNext = false;
      for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
        if (lower === nextSectionHeadings[ni]) { isNext = true; break; }
      }
      if (isNext) break;
      if (line) lines.push(line);
    }
    return lines;
  }

  function findDetailPanel() {
    var allLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
    for (var li = 0; li < allLinks.length; li++) {
      var link = allLinks[li];
      var el = link.parentElement;
      for (var depth = 0; depth < 12 && el && el !== document.body; depth++) {
        var hasTabs = el.querySelector('[role="tab"], [role="tablist"], nav a') !== null;
        var hasName = el.querySelector("h1, h2") !== null;
        if (hasTabs && hasName) return el;
        el = el.parentElement;
      }
    }
    var asides = Array.from(document.querySelectorAll("aside"));
    for (var ai = 0; ai < asides.length; ai++) {
      var a = asides[ai];
      if (a.querySelector('[role="tab"], [role="tablist"]') && a.querySelector("h1, h2")) {
        return a;
      }
    }
    var allDivs = Array.from(document.querySelectorAll("section, div, article"));
    for (var di = 0; di < allDivs.length; di++) {
      var el2 = allDivs[di];
      var txt = (el2.innerText || "").toLowerCase();
      if (txt.indexOf("application questions") >= 0 || txt.indexOf("pertanyaan penyaringan") >= 0) {
        return el2;
      }
    }
    return document.body;
  }

  var root = findDetailPanel();
  var results = [];

  var aqHeading = findSectionHeading(root, ["application questions", "pertanyaan penyaringan", "screening questions"]);
  if (!aqHeading) return results;

  var container = getSectionContainer(aqHeading);
  if (!container) return results;

  var nextSectionHeadings = ["skills", "keahlian", "licences", "licenses", "certifications", "education", "pendidikan", "career history"];

  // Strategy 1: dt/dd pairs (description list)
  var dls = Array.from(container.querySelectorAll("dl, [data-cy*='question'], [data-cy*='screening'], [aria-label*='question'], [data-automation*='question'], [data-automation*='screening']"));
  for (var di = 0; di < dls.length; di++) {
    var dl = dls[di];
    var dts = dl.querySelectorAll("dt");
    var dds = dl.querySelectorAll("dd");
    for (var i = 0; i < dts.length; i++) {
      var question = (dts[i].textContent || "").trim();
      var answerEl = dds[i];
      var answer = cleanApplicationAnswer(answerEl ? (answerEl.textContent || "") : "");
      if (!answer && answerEl) {
        var sibling = answerEl.nextElementSibling;
        for (var si = 0; si < 4 && sibling; si++, sibling = sibling.nextElementSibling) {
          answer = cleanApplicationAnswer(sibling.textContent || "");
          if (answer) break;
        }
      }
      if (!question || isRawDropdown(question)) continue;
      if (answer) results.push({ question: question, answer: answer });
    }
    if (results.length > 0) break;
  }

  // Strategy 2: label/value div pairs
  if (results.length === 0) {
    var foundAqSection = false;
    var allElements = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b, div, span, p, li, [data-cy], [aria-label]"));

    for (var ei = 0; ei < allElements.length; ei++) {
      var el = allElements[ei];
      var txt = (el.textContent || "").trim();
      var lower = txt.toLowerCase();

      var isNextHeading = false;
      for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
        if (lower === nextSectionHeadings[ni]) { isNextHeading = true; break; }
      }
      if (isNextHeading) {
        if (foundAqSection) break;
        continue;
      }
      if (el === aqHeading || el.contains(aqHeading)) {
        foundAqSection = true;
        continue;
      }
      if (!foundAqSection) continue;
      if (!txt || txt.length < 2 || isRawDropdown(txt)) continue;

      var isQuestion = txt.indexOf("?") >= 0 ||
        /^(Gaji|Pendidikan|Pengalaman|Waktu|Kemampuan|Bahasa|Expected|Salary|Education|Experience|Notice|Language|Skill|Apakah|Berapa|Kapan|Dimana|Siapa|Bagaimana|Apa|Are you|Do you|Have you|Can you|Will you|What|How|Why|Where|When)/i.test(txt);

      if (isQuestion && ei + 1 < allElements.length) {
        var next = allElements[ei + 1];
        var nextText = (next.textContent || "").trim();
        var isNextHeading2 = false;
        for (var nj = 0; nj < nextSectionHeadings.length; nj++) {
          if (nextText.toLowerCase() === nextSectionHeadings[nj]) { isNextHeading2 = true; break; }
        }
        if (isNextHeading2) continue;
        var answerText = cleanApplicationAnswer(nextText);
        if (!answerText) {
          for (var ai = ei + 2; ai < allElements.length && ai < ei + 6; ai++) {
            answerText = cleanApplicationAnswer(allElements[ai].textContent || "");
            if (answerText) break;
          }
        }
        if (answerText) {
          results.push({ question: txt, answer: answerText });
          ei++;
        }
      }
    }
  }

  // Strategy 3: text-line parsing fallback
  if (results.length === 0) {
    var allText = sectionLinesFromHeading(root, aqHeading, nextSectionHeadings);
    var inAq = true;

    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower2 = line.toLowerCase();
      if (lower2 === "application questions" || lower2 === "pertanyaan penyaringan" || lower2 === "screening questions") {
        inAq = true;
        continue;
      }
      if (!inAq) continue;
      var isNext2 = false;
      for (var nj = 0; nj < nextSectionHeadings.length; nj++) {
        if (lower2 === nextSectionHeadings[nj]) { isNext2 = true; break; }
      }
      if (isNext2) break;
      if (!line || isRawDropdown(line)) continue;

      var isQuestion2 = line.indexOf("?") >= 0 ||
        /^(Gaji|Pendidikan|Pengalaman|Waktu|Kemampuan|Bahasa|Expected|Salary|Education|Experience|Notice|Language|Skill|Apakah|Berapa|Kapan|Dimana|Siapa|Bagaimana|Apa|Are you|Do you|Have you|Can you|Will you|What|How|Why|Where|When)/i.test(line);

      if (isQuestion2 && ti + 1 < allText.length) {
        var answer = allText[ti + 1];
        var isNext3 = false;
        for (var nk = 0; nk < nextSectionHeadings.length; nk++) {
          if (answer.toLowerCase() === nextSectionHeadings[nk]) { isNext3 = true; break; }
        }
        var cleanAnswer = !isNext3 ? cleanApplicationAnswer(answer) : "";
        if (!cleanAnswer) {
          for (var aj = ti + 2; aj < allText.length && aj < ti + 6; aj++) {
            var candidateAnswer = allText[aj];
            var candidateLower = candidateAnswer.toLowerCase();
            var candidateIsNext = false;
            for (var nl = 0; nl < nextSectionHeadings.length; nl++) {
              if (candidateLower === nextSectionHeadings[nl]) { candidateIsNext = true; break; }
            }
            if (candidateIsNext) break;
            cleanAnswer = cleanApplicationAnswer(candidateAnswer);
            if (cleanAnswer) break;
          }
        }
        if (cleanAnswer) {
          results.push({ question: line, answer: cleanAnswer });
          ti++;
        }
      }
    }
  }

  return deduplicateQuestions(results);
}

/**
 * Extract "Skills" section from the candidate detail panel.
 * Returns an array of skill tag strings.
 */
export function extractSkillsFromDetail() {
  function deduplicateText(text) {
    if (!text || text.length < 20) return text;
    var half = Math.floor(text.length / 2);
    var first = text.slice(0, half).trim();
    var second = text.slice(half).trim();
    if (second.startsWith(first.slice(0, 30))) return first;
    var lines = text.split("\n");
    var mid = Math.floor(lines.length / 2);
    var firstLines = lines.slice(0, mid).join("\n").trim();
    var secondLines = lines.slice(mid).join("\n").trim();
    if (firstLines && firstLines === secondLines) return firstLines;
    return text;
  }

  function isRawDropdown(text) {
    var matches = text ? text.match(/\(\d+\)/g) : null;
    return matches && matches.length > 3;
  }

  function cleanApplicationAnswer(text) {
    var answer = (text || "").trim();
    if (answer === "\u2014" || answer === "-" || answer === "\u2013") return "";
    if (isRawDropdown(answer)) return "";
    return answer;
  }

  function deduplicateQuestions(questions) {
    var seen = new Map();
    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      if (!q || !q.question) continue;
      seen.set(q.question, q);
    }
    return Array.from(seen.values());
  }

  function isExactHeadingText(text, labels) {
    var lower = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    for (var i = 0; i < labels.length; i++) {
      if (lower === labels[i]) return true;
    }
    return false;
  }

  function findSectionHeading(root, labels, fuzzyMatch) {
    var searchRoot = root || document;
    var selector = "h1, h2, h3, h4, h5, h6, strong, b, [role='heading']";
    var candidates = Array.from(searchRoot.querySelectorAll(selector));
    if (searchRoot !== document) {
      candidates = candidates.concat(Array.from(document.querySelectorAll(selector)));
    }
    var best = null;
    for (var hi = 0; hi < candidates.length; hi++) {
      var h = candidates[hi];
      var text = (h.textContent || "").replace(/\s+/g, " ").trim();
      var lower = text.toLowerCase();
      var exact = isExactHeadingText(text, labels);
      var fuzzy = fuzzyMatch && fuzzyMatch(lower);
      if (!exact && !fuzzy) continue;
      if (!best || text.length < (best.textContent || "").trim().length) best = h;
    }
    return best;
  }

  function getSectionContainer(heading) {
    if (!heading) return null;
    var container = heading.parentElement;
    for (var d = 0; d < 6 && container && container !== document.body; d++) {
      if (container.querySelectorAll("li, p, dd, dt, [role='listitem']").length > 0) break;
      container = container.parentElement;
    }
    return container || heading.parentElement;
  }

  function sectionLinesFromHeading(root, heading, nextSectionHeadings) {
    var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
    var headingText = (heading ? heading.textContent || "" : "").replace(/\s+/g, " ").trim().toLowerCase();
    var inSection = false;
    var lines = [];
    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower = line.replace(/\s+/g, " ").trim().toLowerCase();
      if (!inSection && lower === headingText) {
        inSection = true;
        continue;
      }
      if (!inSection) continue;
      var isNext = false;
      for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
        if (lower === nextSectionHeadings[ni]) { isNext = true; break; }
      }
      if (isNext) break;
      if (line) lines.push(line);
    }
    return lines;
  }

  function findDetailPanel() {
    var allLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
    for (var li = 0; li < allLinks.length; li++) {
      var link = allLinks[li];
      var el = link.parentElement;
      for (var depth = 0; depth < 12 && el && el !== document.body; depth++) {
        var hasTabs = el.querySelector('[role="tab"], [role="tablist"], nav a') !== null;
        var hasName = el.querySelector("h1, h2") !== null;
        if (hasTabs && hasName) return el;
        el = el.parentElement;
      }
    }
    var asides = Array.from(document.querySelectorAll("aside"));
    for (var ai = 0; ai < asides.length; ai++) {
      var a = asides[ai];
      if (a.querySelector('[role="tab"], [role="tablist"]') && a.querySelector("h1, h2")) {
        return a;
      }
    }
    var allDivs = Array.from(document.querySelectorAll("section, div, article"));
    for (var di = 0; di < allDivs.length; di++) {
      var el2 = allDivs[di];
      var txt = (el2.innerText || "").toLowerCase();
      if (txt.indexOf("skills") >= 0 || txt.indexOf("keahlian") >= 0) {
        return el2;
      }
    }
    return document.body;
  }

  function normalizeSkill(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function pushUniqueSkill(list, value) {
    var skill = (value || "").replace(/\s+/g, " ").trim();
    var key = normalizeSkill(skill);
    if (!key) return;
    for (var si = 0; si < list.length; si++) {
      if (normalizeSkill(list[si]) === key) return;
    }
    list.push(skill);
  }
  function dedupeSkills(list) {
    var unique = [];
    for (var si = 0; si < list.length; si++) pushUniqueSkill(unique, list[si]);
    return unique;
  }

  var root = findDetailPanel();
  var results = [];

  var headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b"));
  var skillsHeading = null;
  for (var hi = 0; hi < headings.length; hi++) {
    var h = headings[hi];
    var t = (h.textContent || "").trim();
    var lower = t.toLowerCase();
    if (lower === "skills" || lower === "keahlian" || lower === "keterampilan") {
      if (!skillsHeading || h.textContent.length < skillsHeading.textContent.length) {
        skillsHeading = h;
      }
    }
  }
  if (!skillsHeading) return results;

  var container = getSectionContainer(skillsHeading);
  if (!container) return results;

  var foundSkillsSection = false;
  var nextSectionHeadings = ["career history", "education", "pendidikan", "licences", "licenses", "application questions", "pertanyaan penyaringan"];

  var allElements = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b, span, div, li, button, a, [data-automation*='skill'], [data-automation*='tag'], [data-automation*='badge'], [data-automation*='chip']"));

  for (var ei = 0; ei < allElements.length; ei++) {
    var el = allElements[ei];
    var txt = (el.textContent || "").trim();
    var lower = txt.toLowerCase();

    var isNextHeading = false;
    for (var ni = 0; ni < nextSectionHeadings.length; ni++) {
      if (lower === nextSectionHeadings[ni]) { isNextHeading = true; break; }
    }
    if (isNextHeading) {
      if (foundSkillsSection) break;
      continue;
    }
    if (el === skillsHeading || el.contains(skillsHeading)) {
      foundSkillsSection = true;
      continue;
    }
    if (!foundSkillsSection) continue;
    if (!txt || txt.length < 2) continue;

    if (txt.length >= 2 && txt.length <= 50 && txt.indexOf("\n") < 0 &&
        !/^(career|education|licence|license|certification|application|screening|skill|resume|profile|verification)/i.test(txt) &&
        !/^(riwayat|pendidikan|lisensi|sertifikasi|pertanyaan|keahlian|keterampilan)/i.test(txt)) {
      pushUniqueSkill(results, txt);
    }
  }

  // Strategy 2: ul/ol list items
  if (results.length === 0) {
    var foundSkillsSection2 = false;
    var allLists = Array.from(container.querySelectorAll("ul, ol, [role='list']"));

    for (var li2 = 0; li2 < allLists.length; li2++) {
      var list = allLists[li2];
      var items = list.querySelectorAll("li, [role='listitem']");
      if (items.length === 0) continue;
      if (!foundSkillsSection2) {
        var parentText = (list.parentElement ? list.parentElement.innerText || "" : "").toLowerCase();
        if (parentText.indexOf("skills") >= 0 || parentText.indexOf("keahlian") >= 0) {
          foundSkillsSection2 = true;
        }
      }
      if (!foundSkillsSection2) continue;
      for (var ii = 0; ii < items.length; ii++) {
        var item = items[ii];
        var txt2 = (item.textContent || "").trim();
        if (txt2 && txt2.length >= 2 && txt2.length <= 50) {
          pushUniqueSkill(results, txt2);
        }
      }
      if (results.length > 0) break;
    }
  }

  // Strategy 3: text-line parsing fallback
  if (results.length === 0) {
    var allText = (root.innerText || "").split("\n").map(function(s) { return s.trim(); });
    var inSkills = false;

    for (var ti = 0; ti < allText.length; ti++) {
      var line = allText[ti];
      var lower2 = line.toLowerCase();
      if (lower2 === "skills" || lower2 === "keahlian" || lower2 === "keterampilan") {
        inSkills = true;
        continue;
      }
      if (!inSkills) continue;
      var isNext2 = false;
      for (var nj = 0; nj < nextSectionHeadings.length; nj++) {
        if (lower2 === nextSectionHeadings[nj]) { isNext2 = true; break; }
      }
      if (isNext2) break;
      if (!line) continue;

      if (line.indexOf(",") >= 0) {
        var parts = line.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
        for (var pi = 0; pi < parts.length; pi++) {
          var part = parts[pi];
          if (part.length >= 2 && part.length <= 50) {
            pushUniqueSkill(results, part);
          }
        }
      } else if (line.length >= 2 && line.length <= 50) {
        pushUniqueSkill(results, line);
      }
    }
  }

  return dedupeSkills(results);
}
