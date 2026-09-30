#!/usr/bin/env python3
"""Checks for the pure parsing/matching functions in Code.gs.

The real Code.gs runs in QuickJS (pip install quickjs) with the Apps Script
globals stubbed, so this tests the shipping code rather than a copy of it.

Run from the repo root:  python3 test/run.py
"""
import json
import os
import sys

try:
    import quickjs
except ImportError:
    sys.exit("pip install quickjs")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Code.gs only touches these inside the Gmail/Sheets entry points, which these
# checks don't call. Stubbing them lets the file load.
STUBS = (
    "globalThis.SpreadsheetApp = globalThis.GmailApp = globalThis.ScriptApp ="
    "globalThis.PropertiesService = globalThis.LockService = globalThis.Session ="
    "globalThis.Utilities = {};"
    "globalThis.console = {log: function () {}};"
)


def context():
    ctx = quickjs.Context()
    ctx.eval(STUBS)
    ctx.eval(open(os.path.join(ROOT, "Code.gs")).read())
    return ctx


def js(ctx, expr, *args):
    """Evaluate expr (a %s-format string taking JSON-encoded args) and parse the result."""
    code = expr % tuple(json.dumps(a) for a in args) if args else expr
    return json.loads(ctx.eval("JSON.stringify(%s)" % code))


# --- Status classification --------------------------------------------------
# Rejections are the emails that vary most, and every one of these came back
# unclassified (or, worse, "Applied") before the patterns were widened.

STATUS_CASES = [
    # (text, expected status)
    ("Thank you for applying to Stripe. Our team will review your application.", "Applied"),
    ("Thank you for applying! If your qualifications match, we will reach out to schedule an interview.", "Applied"),
    ("You have been invited to complete the online assessment.", "Assessment"),
    ("Please use the link below to schedule your interview.", "Interview"),
    ("We are pleased to offer you the Software Engineer Intern position.", "Offer"),

    ("Unfortunately, we will not be moving forward with your application at this time.", "Rejected"),
    ("Unfortunately, we won't be moving forward with your candidacy.", "Rejected"),
    ("We can't move forward with your application.", "Rejected"),
    ("Unfortunately we cannot proceed with your candidacy at this time.", "Rejected"),
    ("After careful consideration, we have chosen to move forward with other candidates.", "Rejected"),
    ("We will be moving forward with other candidates for this role.", "Rejected"),
    ("While your background is impressive, we are moving ahead with other candidates.", "Rejected"),
    ("Unfortunately, you are no longer being considered for this position.", "Rejected"),
    ("Thank you for your interest. Unfortunately, we have filled this position.", "Rejected"),
    ("The position has been filled.", "Rejected"),
    ("We've decided to pursue other applicants whose experience more closely aligns.", "Rejected"),
    ("Unfortunately, we are unable to move forward with your application.", "Rejected"),
    ("We regret to inform you that we have selected another candidate.", "Rejected"),
    ("Your application was not successful on this occasion.", "Rejected"),
    ("Unfortunately, we will not be progressing your application further.", "Rejected"),
    ("We have decided not to move forward with your application.", "Rejected"),
    ("Thank you for applying. Unfortunately, you were not selected for this role.", "Rejected"),
    ("We are not able to offer you a position at this time.", "Rejected"),

    # Conditional next steps read like rejections but aren't.
    ("We cannot move forward until you complete the online assessment.", "Assessment"),
    ("We can't proceed with scheduling unless you send your availability.", "Interview"),
    ("We'd like to move forward with your application and schedule a phone screen. Please share your availability.", "Interview"),

    ("Your package has shipped and will arrive Tuesday.", None),
]

# --- Term detection --------------------------------------------------------
# Real titles put words between the season and the year, or give a year with no
# season at all. Both used to land in "No Term".

TERM_CASES = [
    ("Software Engineering Intern, Summer 2027", "Summer 2027"),
    ("Software Engineer Intern - Summer 2026", "Summer 2026"),
    ("Software Engineer Intern (Summer 2027)", "Summer 2027"),
    ("Product Management Intern | Summer 2026", "Summer 2026"),
    ("Data Science Intern, Summer 2027 (Remote)", "Summer 2027"),
    ("2026 Summer Analyst Program", "Summer 2026"),
    ("2027 Summer Analyst Program", "Summer 2027"),
    ("Summer Internship 2027 - Software Engineering", "Summer 2027"),
    ("Autumn 2026 Research Intern", "Fall 2026"),
    ("Spring Co-op 2027", "Spring 2027"),
    ("Data Science Intern - Fall '26", "Fall 2026"),
    ("Intern - Summer '27", "Summer 2027"),
    # Season and year separated by other words.
    ("Finance Summer Analyst 2027", "Summer 2027"),
    ("Summer Analyst Intern (2026)", "Summer 2026"),
    # No separator at all.
    ("Software Engineer Internship Summer2026", "Summer 2026"),
    # Year with no season: the year alone is the term.
    ("Software Engineering Intern - 2027", "2027"),
    ("SWE Intern 2027", "2027"),
    ("2027 Internship - Software Engineer", "2027"),
    ("Software Engineering Intern - 2027 (JR1987654)", "2027"),
    ("Software Engineer, New Grad 2027", "New Grad 2027"),
    ("2027 University Graduate - Software Engineer", "New Grad 2027"),
    # No term to find.
    ("Summer 10-week program", ""),
    ("Software Engineer Intern", ""),
    ("Senior Software Engineer", ""),
]

# --- Company from the email address ---------------------------------------
# For a company's own domain the domain names the employer; for an ATS the local
# part often does ("<company>@myworkday.com"). Everything generic must stay empty
# so the subject or body gets a turn instead.

ADDRESS_CASES = [
    ("recruiting@datadoghq.com", "Datadog"),          # trailing "hq" stripped
    ("careers@acme.co.uk", "Acme"),                   # two-level suffix, not "Co"
    ("team@acme.com.au", "Acme"),
    ("noreply@mail.ramp.com", "Ramp"),                # subdomain ignored
    ("jobs@hire.notion.so", "Notion"),
    ("priya.raman@figma.com", "Figma"),               # individual recruiter
    ("talent@goldmansachs.com", "Goldman Sachs"),     # known multi-word name
    ("university@jpmorganchase.com", "JPMorgan Chase"),
    ("recruiting@janestreet.com", "Jane Street"),
    ("nvidia@myworkday.com", "NVIDIA"),               # ATS: employer in local part
    ("figma@talent.icims.com", "Figma"),
    ("no-reply@icims.com", ""),                       # ATS: generic local part
    ("jobs-noreply@linkedin.com", ""),
    ("support@hackerrankforwork.com", ""),
    ("noreply@us.greenhouse-mail.io", ""),
    ("jane.doe@gmail.com", ""),                       # personal mailbox
    ("someone@outlook.com", ""),
]


# --- Whole emails ----------------------------------------------------------

EMAIL_CASES = [
    dict(
        name="Greenhouse confirmation",
        email=dict(
            **{"from": "Stripe Hiring Team <no-reply@us.greenhouse-mail.io>"},
            subject="Thank you for applying to Stripe",
            body="Hi Az,\n\nThanks for applying to the Software Engineering Intern, Summer 2027 position at Stripe. "
                 "Our team will review your application.\n\n"
                 "View the job: https://boards.greenhouse.io/stripe/jobs/6012345",
        ),
        want={"status": "Applied", "company": "Stripe", "role": "Software Engineering Intern, Summer 2027",
              "term": "Summer 2027", "link": "https://boards.greenhouse.io/stripe/jobs/6012345"},
    ),
    dict(
        name="Workday confirmation: year with no season still gets a term",
        email=dict(
            **{"from": "nvidia@myworkday.com"},
            subject="Application Received",
            body="Thank you for your application. We have received your application for "
                 "Software Engineering Intern - 2027 (JR1987654).",
        ),
        want={"status": "Applied", "company": "NVIDIA", "term": "2027"},
    ),
    dict(
        name="Lever confirmation",
        email=dict(
            **{"from": "Ramp <no-reply@hire.lever.co>"},
            subject="Thanks for applying to Ramp!",
            body="Hi Az, thank you for your interest in the Software Engineer Intern role at Ramp. "
                 "https://jobs.lever.co/ramp/abc-123",
        ),
        want={"status": "Applied", "company": "Ramp", "role": "Software Engineer Intern",
              "link": "https://jobs.lever.co/ramp/abc-123"},
    ),
    dict(
        name="LinkedIn Easy Apply",
        email=dict(
            **{"from": "LinkedIn <jobs-noreply@linkedin.com>"},
            subject="Az, your application was sent to Jane Street",
            body="Your application was sent to Jane Street\nSoftware Engineer Intern\n"
                 "https://www.linkedin.com/jobs/view/3999999999/",
        ),
        want={"status": "Applied", "company": "Jane Street",
              "link": "https://www.linkedin.com/jobs/view/3999999999/"},
    ),
    dict(
        name="Confirmation mentioning a future interview is still Applied",
        email=dict(
            **{"from": "Datadog Recruiting <recruiting@datadoghq.com>"},
            subject="Datadog - Application Received",
            body="Thank you for applying! If your qualifications match, we will reach out to schedule an interview.",
        ),
        want={"status": "Applied", "company": "Datadog"},
    ),
    dict(
        name="Rejection that also says thank you for applying",
        email=dict(
            **{"from": "Stripe Hiring Team <no-reply@us.greenhouse-mail.io>"},
            subject="Your application to Stripe",
            body="Thank you for applying to Stripe. Unfortunately, we have decided to move forward with other "
                 "candidates for the Software Engineering Intern, Summer 2027 position.",
        ),
        want={"status": "Rejected", "company": "Stripe", "term": "Summer 2027"},
    ),
    dict(
        name="Vague-subject rejection from a plain recruiter address",
        email=dict(
            **{"from": "Priya Raman <priya.raman@figma.com>"},
            subject="Update on your candidacy",
            body="Hi Az, thank you for taking the time to interview for the Product Design Intern, Summer 2027 role. "
                 "After careful consideration, we have chosen to move forward with other candidates.",
        ),
        want={"status": "Rejected", "company": "Figma", "term": "Summer 2027"},
    ),
    dict(
        name="Interview invite",
        email=dict(
            **{"from": "Ramp Recruiting <recruiting@ramp.com>"},
            subject="Next steps with Ramp",
            body="Hi Az, we'd like to invite you to a phone screen for the Software Engineer Intern role. "
                 "Please share your availability.",
        ),
        want={"status": "Interview", "company": "Ramp"},
    ),
    dict(
        name="HackerRank OA",
        email=dict(
            **{"from": "HackerRank <support@hackerrankforwork.com>"},
            subject="Invitation: Two Sigma Online Assessment",
            body="You have been invited to take the Two Sigma online assessment.",
        ),
        want={"status": "Assessment", "company": "Two Sigma"},
    ),
    dict(
        name="Job alert noise is ignored",
        email=dict(
            **{"from": "Handshake <no-reply@joinhandshake.com>"},
            subject="10 new jobs for you",
            body="Check out these jobs you may like.",
        ),
        want=None,
    ),
]


def check_emails(ctx, problems):
    for case in EMAIL_CASES:
        email = dict(case["email"])
        email["date"] = None  # set in JS, Date isn't JSON
        got = js(
            ctx,
            "(function(e){e.date = new Date('2026-09-20'); return parseEmail(e) || null;})(%s)",
            email,
        )
        if case["want"] is None:
            if got is not None:
                problems.append("%s: expected no row, got %r" % (case["name"], got))
            continue
        if got is None:
            problems.append("%s: got no row" % case["name"])
            continue
        for key, want in case["want"].items():
            if got.get(key) != want:
                problems.append("%s: %s = %r, want %r" % (case["name"], key, got.get(key), want))


def check_tables(ctx, problems):
    # Same company and role in different terms are different applications; a
    # term-less rejection still finds its row.
    got = js(ctx, """(function(){
      var t = {rows: []};
      [['Applied','Stripe','SWE Intern','Summer 2026','2025-09-01'],
       ['Applied','Stripe','SWE Intern','Summer 2027','2026-09-01'],
       ['Rejected','Stripe','SWE Intern','Summer 2027','2026-09-10'],
       ['Interview','Ramp','','','2026-09-12']].forEach(function(r){
        applyToTable_(t, {status:r[0], company:r[1], role:r[2], term:r[3], date:new Date(r[4]), link:'', notes:''});
      });
      return t.rows.map(function(r){return (r.term||'No Term')+':'+r.values.Company+':'+r.values.Status;}).join(', ');
    })()""")
    want = "Summer 2026:Stripe:Applied, Summer 2027:Stripe:Rejected, No Term:Ramp:Interview"
    if got != want:
        problems.append("terms keep applications separate:\n     want %s\n     got  %s" % (want, got))

    # A confirmation, then an OA, then a rejection is one row, not three.
    got = js(ctx, """(function(){
      var t = {header: [], rows: []};
      [['Applied','Stripe','Software Engineering Intern','https://boards.greenhouse.io/stripe/jobs/1','2026-09-01'],
       ['Assessment','Stripe','','','2026-09-05'],
       ['Applied','Stripe','Data Science Intern','','2026-09-06'],
       ['Rejected','Stripe, Inc.','Software Engineering Intern','','2026-09-10'],
       ['Applied','Stripe','Software Engineering Intern','','2026-09-11']].forEach(function(r){
        applyToTable_(t, {status:r[0], company:r[1], role:r[2], link:r[3], date:new Date(r[4]), notes:''});
      });
      return t.rows.map(function(r){return r.values.Role+':'+r.values.Status;}).join(', ');
    })()""")
    want = "Software Engineering Intern:Rejected, Data Science Intern:Applied"
    if got != want:
        problems.append("status updates merge into existing rows:\n     want %s\n     got  %s" % (want, got))

    # A bare-year row and a later "Summer <year>" email are one application.
    got = js(ctx, """(function(){
      var t = {header: [], rows: []};
      applyToTable_(t, {status:'Applied', company:'Nvidia', role:'SWE Intern', term:'2027', date:new Date('2026-09-01'), link:'', notes:''});
      applyToTable_(t, {status:'Rejected', company:'Nvidia', role:'SWE Intern', term:'Summer 2027', date:new Date('2026-09-20'), link:'', notes:''});
      return t.rows.length + ':' + t.rows[0].values.Status;
    })()""")
    if got != "1:Rejected":
        problems.append("bare-year row matches a later seasoned email: got %s, want 1:Rejected" % got)

    # Hand-typed statuses are never overwritten.
    got = js(ctx, """(function(){
      var t = {header: [], rows: [{isNew:false, dirty:new Set(), values:{Company:'Ramp', Role:'SWE Intern', Status:'Withdrawn'}}]};
      applyToTable_(t, {status:'Rejected', company:'Ramp', role:'SWE Intern', link:'', date:new Date('2026-09-12'), notes:''});
      return t.rows[0].values.Status;
    })()""")
    if got != "Withdrawn":
        problems.append("hand-typed status was overwritten with %r" % got)


def check_tab_order(ctx, problems):
    got = js(ctx, """['No Term','Fall 2026','Summer 2027','2027','Spring 2027','New Grad 2027','Winter 2027']
      .sort(function(a,b){return termSortKey(b) - termSortKey(a);}).join(', ')""")
    want = "New Grad 2027, Summer 2027, Spring 2027, Winter 2027, 2027, Fall 2026, No Term"
    if got != want:
        problems.append("tab order:\n     want %s\n     got  %s" % (want, got))


def main():
    ctx = context()
    problems = []

    for text, want in STATUS_CASES:
        got = js(ctx, "classifyStatus(%s) || null", text)
        if got != want:
            problems.append("status %r: got %r, want %r" % (text[:60], got, want))

    for text, want in TERM_CASES:
        got = js(ctx, "extractTerm(%s)", text)
        if got != want:
            problems.append("term %r: got %r, want %r" % (text, got, want))

    for addr, want in ADDRESS_CASES:
        got = js(ctx, "companyFromSenderAddress_(%s)", addr)
        if got != want:
            problems.append("address %r: got %r, want %r" % (addr, got, want))

    check_emails(ctx, problems)
    check_tables(ctx, problems)
    check_tab_order(ctx, problems)

    total = len(STATUS_CASES) + len(TERM_CASES) + len(ADDRESS_CASES) + len(EMAIL_CASES) + 5
    for p in problems:
        print("FAIL %s" % p)
    print("\n%d checks, %d failing" % (total, len(problems)))
    print("query length: %d chars" % len(js(ctx, "buildQuery(%s)", "newer_than:2d")))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
