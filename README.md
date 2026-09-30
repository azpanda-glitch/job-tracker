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

   This backfills the last 12 months and installs an hourly scan. Apps Script stops
   runs at 6 minutes, so the backfill works through the year in 2-week slices, oldest
   first, and schedules itself to resume a minute later until it's done. A big inbox
   can take several runs; progress shows under Apps Script > Executions.
   Term tabs appear as applications are found.
4. Reload the Sheet. A "Job Tracker" menu appears with "Scan now" and "Backfill".

## How the company is identified
In order, first hit wins:
1. The subject ("Thank you for applying to **Stripe**", LinkedIn's "your application was sent to **X**").
2. The sender's display name, unless it's a person's name that's also spelled out in the address.
3. **The sending domain.** `recruiting@datadoghq.com` -> Datadog, `careers@acme.co.uk` -> Acme,
   `noreply@mail.ramp.com` -> Ramp. Personal domains (Gmail, Outlook) are skipped.
   For ATS senders the local part is used instead, since that's where the employer usually
   sits (`nvidia@myworkday.com`, `figma@talent.icims.com`); a generic one (`no-reply@`,
   `jobs-noreply@`) is ignored.
4. The **Reply-To** address, read the same way. ATS mail often replies to the employer's recruiter.
5. The body ("...your application **at X**").

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
| `ATS_DOMAINS` | senders that are always worth scanning (Workday, Greenhouse, Lever, ...) |
| `SUBJECT_PHRASES` | subject wording that marks an application email |
| `BODY_PHRASES` | wording searched anywhere in the message, which is how rejections from a plain recruiter address with a vague subject get found |
| `NOISE_SUBJECTS` | subjects to exclude (job alerts) |
| `STATUS_PATTERNS` | the wording that sets each status |
| `DOMAIN_COMPANY_NAMES` | domains that don't read as a name when capitalized (`goldmansachs` -> Goldman Sachs). Add your own |
| `FREE_MAIL` | personal mail domains, which never name a company |

The Gmail search is deliberately wide -- `STATUS_PATTERNS` is the real filter, so a
thread that matches the search but isn't an application email simply produces no row.

After changes, run the parser tests:

    python3 test/run.py   # needs: pip install quickjs
