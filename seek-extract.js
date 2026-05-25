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
    source: "SEEK",
  };
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
  const root =
    document.querySelector("#braid-modal-container") ||
    document.querySelector('[role="dialog"]') ||
    document.body;

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

  let domicileLocation = null;
  const locAutomation = root.querySelector(
    '[data-automation*="location"], [data-automation*="address"]',
  );
  if (locAutomation) {
    const t = locAutomation.textContent?.trim();
    if (t && t.length > 3 && t.length < 80) domicileLocation = t;
  }
  if (!domicileLocation) {
    const locEl = [...root.querySelectorAll("span, p, div")].find((el) => {
      const t = (el.textContent || "").trim();
      return (
        t.length > 5 &&
        t.length < 80 &&
        el.children.length === 0 &&
        /(Kabupaten|Kota|Jakarta|Surabaya|Bandung|Bali|Yogyakarta|Semarang|Medan|Denpasar|Indonesia)/i.test(
          t,
        )
      );
    });
    if (locEl) domicileLocation = locEl.textContent?.trim() || null;
  }

  return { name, email, phone, profileUrl, location: domicileLocation };
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
