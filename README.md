# Job Application Tracker

Google Apps Script that watches Gmail for application confirmations and updates
(online assessment, interview, rejection, offer) and logs them to a Google
Sheet, with one tab per term: "Summer 2027", "Spring 2027", "New Grad 2027", etc.

## Setup
1. Open (or create) the Google Sheet you want to use.
2. Extensions > Apps Script. Replace the contents of `Code.gs` with this repo's `Code.gs`. Save.
3. Select `setup` in the function dropdown and click Run. Approve the Gmail + Sheets permissions.
   This backfills the last 12 months and installs an hourly scan. Apps Script stops
   runs at 6 minutes, so the backfill works through the year in 2-week slices, oldest
   first, and schedules itself to resume a minute later until it's done. A big inbox
   can take several runs; progress shows under Apps Script > Executions.
   Term tabs appear as applications are found.
4. Reload the Sheet. A "Job Tracker" menu appears with "Scan now" and "Backfill".

## Behavior
- Tabs are created automatically, newest term first. The term is read from the role
  title or email ("Intern, Summer 2027", "Fall '26", "2027 Summer Analyst").
  Applications with no term go to the "No Term" tab; drag rows to the right tab if needed.
- One row per application; later emails update the row's Status instead of adding rows.
- Status only moves forward: Applied → Assessment → Interview → Rejected/Offer.
  Statuses you type yourself (e.g. Withdrawn, Ghosted) are never overwritten.
- Rows the parser couldn't fully read are flagged "Needs review" in Notes.
- After the backfill, hourly scans only look at the last 2 days; anything already
  processed (IDs in the hidden `_seen` tab) is skipped. Delete `_seen` and run
  Job Tracker > Backfill to rescan everything.

## Tuning
Edit the constants at the top of `Code.gs`: `ATS_DOMAINS`, `SUBJECT_PHRASES`,
`NOISE_SUBJECTS`, and `STATUS_PATTERNS`. After changes, run the parser tests:

    node test/parse.test.js
