# Job Application Tracker

Google Apps Script that watches Gmail for application confirmations and updates
(online assessment, interview, rejection, offer) and logs them to a Google
Sheet, with one tab per term: "Summer 2027", "Spring 2027", "New Grad 2027", etc.

## Setup
1. Open (or create) the Google Sheet you want to use.
2. Extensions > Apps Script. Replace the contents of `Code.gs` with this repo's `Code.gs`. Save.
   Click **Untitled project** at the top-left and rename it (e.g. "Job Tracker") -- that name is
   what the permission screen in the next step shows you, so "Untitled project" there is just
   this project, not something suspicious.
3. Select `setup` in the function dropdown and click Run, then approve the Gmail + Sheets permissions.

   **"Google hasn't verified this app"** appears here, and it's expected: this is your own
   script, and verification only applies to apps published to other people. Click
   **Advanced**, then **Go to \<project name\> (unsafe)**, then **Allow**. Nothing leaves your
   Google account. If there's no **Advanced** link, you're on a school or work account whose
   admin blocks unverified scripts — use a personal Gmail account instead.

   With `appsscript.json` in place, these are the permissions it asks for:

   | Permission | Why |
   |---|---|
   | **View your email messages and settings** (`gmail.readonly`) | reads application emails. It cannot send, delete, or change anything |
   | See, edit, create and delete **only this spreadsheet** (`spreadsheets.currentonly`) | writes the rows. No access to your other Drive files |
   | Run when you're not present (`script.scriptapp`) | the hourly scan |
   | Display and run third-party web content (`script.container.ui`) | the "Job Tracker" menu |
   | Connect to an external service (`script.external_request`) | looks up posting links on public job boards |
   | See your primary email address (`userinfo.email`) | so your own replies are skipped |

   Without that manifest, Apps Script asks for the broadest Gmail permission instead
   ("Read, compose, send, and **permanently delete** all your email"), which is far more than
   this script does.

   This backfills the last 12 months and installs an hourly scan. Apps Script stops
   runs at 6 minutes, so the backfill works through the year in 2-week slices, oldest
   first, and schedules itself to resume a minute later until it's done. A big inbox
   can take several runs; progress shows under Apps Script > Executions.
   Term tabs appear as applications are found.
4. Reload the Sheet. A "Job Tracker" menu appears with "Scan now" and "Backfill".

## "Why does it say Google hasn't verified this app?"
Because each person runs their own copy. The script lives in **your** Apps Script project in
**your** Google account, so there's no third-party app in the middle and nothing for Google to
verify — that review is for apps published to other people. The tradeoff is the warning
screen; the upside is that your email never touches anyone else's server.

What makes it checkable rather than just trust-me:
- The code is all here, in one file, and you paste it in yourself.
- The permissions it asks for are listed in `appsscript.json`, and the table in step 3 explains
  each one. Gmail access is **read-only**: it can't send, delete, or change anything.
- Revoke it any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Removing the warning would mean publishing this as a hosted app that reads *other* people's
Gmail. Gmail read access is a **restricted** OAuth scope, so that route requires app
verification plus an annual third-party security assessment, a privacy policy, terms, and a
demo video — and it would route your email through someone else's servers. Clicking past one
warning screen is the better trade.

## How the company is identified
In order, first hit wins:
1. The subject ("Thank you for applying to **Stripe**", LinkedIn's "your application was sent to **X**").
2. The sender's display name, **unless it's a person**. `Priya Raman <praman@figma.com>` is
   Figma, not Priya Raman. "Priya **at Figma**" and "Datadog Recruiting" work as you'd expect.
3. **The sending domain.** `recruiting@datadoghq.com` -> Datadog, `careers@acme.co.uk` -> Acme,
   `noreply@mail.ramp.com` -> Ramp. Personal domains (Gmail, Outlook) are skipped.
4. The **Reply-To** address, read the same way.
5. The body ("...your application **at X**").
6. Last resort: a person-looking display name on ATS mail, flagged "Needs review" since it
   might be the recruiter.

Two kinds of sender never name the company:
- **ATS platforms** (Greenhouse, Lever, Workday, ...): their domain is skipped. Workday and
  iCIMS are the exception, since they put the employer in the address (`nvidia@myworkday.com`).
- **Recruiting tools** that email for many employers: schedulers (GoodTime, Calendly),
  chatbots (Paradox), CRMs (Gem, Yello), assessments (Karat, SHL), and job boards (Wellfound,
  Indeed, RippleMatch). These are listed in `RECRUITING_TOOL_DOMAINS`. Without that list,
  applications to different employers sent through the same tool merged into one row.

## Posting links
If the email links to the posting, that link is used. If not:
- **Emails from the last 7 days:** the tracker looks the posting up on the company's public
  job board (Greenhouse, Lever, or Ashby) and matches it to the role. Every meaningful word
  of the role has to be in the title, so "Software Engineer Intern" never lands on a full-time
  "Senior Software Engineer" job; if nothing matches, it keeps the search link.
- **Older emails** (most of the backfill) keep a Google search link and skip the lookup.
  Those postings are usually closed by now.

Optional: for companies on other job boards, add a Google Programmable Search key and
engine ID to `SEARCH_API_KEY` / `SEARCH_ENGINE_ID` at the top of `Code.gs`, and the first
result is used.

The lookup needs one extra permission (connecting to external services). The first run
after updating asks you to approve it.

## When an application is missing
**Job Tracker > Show skipped emails** opens a log of emails that looked application-related
(from a recruiting platform, or a subject like "your application") but couldn't be turned into
a row. Usually it's wording the status patterns don't know yet. Send the sentence that should
have matched, add it to `STATUS_PATTERNS`, delete the hidden `_seen` tab, and run Backfill.

## Behavior
- Tabs are created automatically, newest term first. The term is read from the role
  title or email ("Intern, Summer 2027", "Fall '26", "2027 Summer Analyst"). Season and
  year don't have to be adjacent, so "Finance Summer Analyst 2027" works too.
- When a posting names a year but no season ("SWE Intern - 2027"), the tab is just the
  year ("2027"). Drag those rows into a season tab if you know which one it is; a later
  email that does name the season updates the same row rather than adding a new one.
  Applications with no year at all go to the "No Term" tab.
- One row per application; later emails update the row's Status instead of adding rows.
- Status only moves forward: Applied → Assessment → Interview → Rejected/Offer.
  Statuses you type yourself (e.g. Withdrawn, Ghosted) are never overwritten.
- Rows the parser couldn't fully read are flagged "Needs review" in Notes.
- After the backfill, hourly scans only look at the last 2 days; anything already
  processed (IDs in the hidden `_seen` tab) is skipped. Delete `_seen` and run
  Job Tracker > Backfill to rescan everything.

## Troubleshooting

- **"Google hasn't verified this app":** expected. See step 3 above.
- **"Authorization is required to perform that action":** the hourly trigger was installed
  before permissions were granted. Run `setup` again from the Apps Script editor.
- **No rows after the first run:** the backfill works in slices and may still be running.
  Check Apps Script > Executions. If `continueBackfill` keeps appearing, it's still going.
- **Applications missing:** the email didn't match `ATS_DOMAINS`, `SUBJECT_PHRASES`, or
  `BODY_PHRASES`. Add the sender's domain to `ATS_DOMAINS` (or the wording to the phrase
  lists), delete the hidden `_seen` tab, and run Job Tracker > Backfill.
- **A row's status is behind:** the email's wording isn't in `STATUS_PATTERNS`. Paste the
  sentence into the relevant pattern and re-run Backfill. Rejection wording varies the most,
  so that's the usual culprit.

## Tuning
Edit the constants at the top of `Code.gs`:

| Constant | What it controls |
|---|---|
| `ATS_DOMAINS` | applicant tracking systems that are always worth scanning (Workday, Greenhouse, Lever, ...) |
| `RECRUITING_TOOL_DOMAINS` | schedulers, chatbots, CRMs and job boards that email for many employers: scanned, but never used as the company |
| `SUBJECT_PHRASES` | subject wording that marks an application email |
| `BODY_PHRASES` | wording searched anywhere in the message, which is how rejections from a plain recruiter address with a vague subject get found |
| `NOISE_SUBJECTS` | subjects to exclude (job alerts) |
| `CONFIG.LOOKUP_DAYS` | how recent an email must be for its posting to be looked up (default 7) |
| `STATUS_PATTERNS` | the wording that sets each status |
| `DOMAIN_COMPANY_NAMES` | domains that don't read as a name when capitalized (`goldmansachs` -> Goldman Sachs). Add your own |
| `FREE_MAIL` | personal mail domains, which never name a company |

The Gmail search is deliberately wide -- `STATUS_PATTERNS` is the real filter, so a
thread that matches the search but isn't an application email simply produces no row. It runs
as several short searches merged by thread, rather than one long query.

After changes, run the parser tests:

    python3 test/run.py   # needs: pip install quickjs
