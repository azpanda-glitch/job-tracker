# Job Application Tracker

Google Apps Script that watches Gmail for application confirmations and updates
(online assessment, interview, rejection, offer) and logs them to a Google
Sheet, with one tab per term: "Summer 2027", "Spring 2027", "New Grad 2027", etc.

## Setup
1. Open (or create) the Google Sheet you want to use.
2. Extensions > Apps Script. Replace the contents of `Code.gs` with this repo's `Code.gs`. Save.
3. Select `setup` in the function dropdown and click Run. Approve the Gmail + Sheets permissions.
   This backfills the last 90 days and installs an hourly scan.
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
- Processed message IDs live in the hidden `_seen` tab. Delete it to rescan everything.

## Tuning
Edit the constants at the top of `Code.gs`: `ATS_DOMAINS`, `SUBJECT_PHRASES`,
`NOISE_SUBJECTS`, and `STATUS_PATTERNS`. After changes, run the parser tests:

    node test/parse.test.js
