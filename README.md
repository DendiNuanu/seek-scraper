# SEEK Employer → Nuanu HR ATS

Playwright scraper that runs on your machine (not Vercel) and POSTs candidates to the Nuanu ATS import API.

## Setup

```bash
cd ~/seek-scraper
cp .env.example .env
# Edit .env: SEEK_PASSWORD, confirm NUANU_API_KEY matches Vercel SEEK_IMPORT_KEY

npm install
npm run setup   # installs Chromium once
```

## Recommended: save login session once

Automated Auth0 login often fails on captcha or special characters in passwords. **Sign in manually once** and reuse the saved session:

```bash
npm run login
```

A headed browser opens. Sign in to SEEK (complete captcha if prompted). When you reach the employer dashboard, the script saves your login to **`.seek-browser-profile/`** (and a `seek-auth.json` backup).

Then run the scraper:

```bash
npm start
# or scrape-only test:
npm run dry-run
```

The scraper reuses the same browser profile as `npm run login`. **Automated SEEK_EMAIL/SEEK_PASSWORD login is disabled** (unreliable with captcha and `#` in passwords).

If `npm start` says the session expired while headless, either run `npm run login` again or use a visible browser:

```bash
HEADLESS=false npm start
```

Never commit `.seek-browser-profile/`, `seek-auth.json`, or `.env`.

## Test API (after Vercel deploy + env var)

```bash
npm run test-api
```

## Run scraper

```bash
npm start
# scrape only — no API POST, prints candidate names:
npm run dry-run
# or visible browser for debugging:
npm run debug
# or HEADLESS=false in .env for first automated attempt
```

## SEEK pages scraped

| Page | URL | What is extracted |
|------|-----|-------------------|
| Past applicants | `https://id.employer.seek.com/your-candidates` (tab **Past applicants**) | Table rows, then **each name opened** for email, phone, and resume download (`downloads/`) |
| Dashboard + Open jobs | `/dashboard` and `/jobs` (tab **Open**) | Job IDs from `candidates?jobid=` links and embedded page JSON |
| Job pipeline | `https://id.employer.seek.com/candidates?jobid={id}` | Candidate cards, sidebar filters (Inbox, Prescreen, …), SEEK API JSON |

**Do not use** `/applicants/` or `/job/` URLs — SEEK Indonesia uses `candidates?jobid=` for applicant lists.

By default the scraper clicks **each candidate name** on Past applicants to read email/phone and download the CV. Set `FETCH_CONTACT_DETAILS=false` for list-only (faster). Job pipeline modals use `candidates/?jobId={id}&selected={uuid}` when `SCRAPE_JOBS=true`.

Deduplication key: `name + phone + email`.

Downloaded CVs in `downloads/` are sent to the ATS API as base64 and stored in **Supabase** (`resumeUrl` on the candidate profile). Ensure Vercel has `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configured on the ATS project.

## Verify `.env` password parsing

```bash
npm run test-env
# Expect: length: 8  endsWith#: true  (for an 8-char password ending in #)
```

On startup, `npm start` also logs `SEEK_PASSWORD length: N` (never the actual password). If length is wrong, fix quoting in `.env`.

## SEEK login (manual only)

Use `npm run login` — do not rely on `SEEK_PASSWORD` in `.env` for scraping. SEEK uses Auth0 + captcha; wrong or truncated passwords (e.g. unquoted `#` in `.env`) cause “We don’t recognise that combination.”

If scraping fails after login, check `debug-screenshot.png` and run with `HEADLESS=false npm start`.

### Passwords with `#` in `.env`

[dotenv](https://github.com/motdotla/dotenv) treats `#` as the start of a comment unless the value is quoted. An unquoted line like `SEEK_PASSWORD=Fukada!#` is parsed as `Fukada!` (everything after `#` is dropped), which causes SEEK’s “We don’t recognise that combination” error even when the password is correct.

Always wrap passwords that contain `#` (or other special characters) in **double quotes**:

```env
SEEK_PASSWORD="your-password-here"
```

Single quotes also work. See `.env.example`.

Headless runs may be blocked by Cloudflare Turnstile. Use `npm run login` (headed, manual sign-in) instead of `npm run debug` when possible.

## Notes

- Never commit `.env` or `seek-auth.json`.
- If SEEK changes login HTML, run `npm run debug` and update `LOGIN_SELECTORS` in `seek-auth.js`.
