// Runs the pure parsing/matching functions from Code.gs against sample emails.
// Usage: node test/parse.test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') +
  '\n;this.api = {parseEmail, applyToTable_, buildQuery, extractTerm, termSortKey};', ctx);
const { parseEmail, applyToTable_, buildQuery, extractTerm, termSortKey } = ctx.api;

const d = s => new Date(s);
const cases = [
  {
    name: 'Greenhouse confirmation',
    email: { from: 'Stripe Hiring Team <no-reply@us.greenhouse-mail.io>', subject: 'Thank you for applying to Stripe',
      body: 'Hi Az,\n\nThanks for applying to the Software Engineering Intern, Summer 2027 position at Stripe. Our team will review your application.\n\nView the job: https://boards.greenhouse.io/stripe/jobs/6012345' },
    want: { status: 'Applied', company: 'Stripe', role: 'Software Engineering Intern, Summer 2027', term: 'Summer 2027', link: 'https://boards.greenhouse.io/stripe/jobs/6012345' },
  },
  {
    name: 'Workday confirmation, company only in sender local part',
    email: { from: 'nvidia@myworkday.com', subject: 'Application Received',
      body: 'Thank you for your application. We have received your application for Software Engineering Intern - 2027 (JR1987654).' },
    want: { status: 'Applied', company: 'Nvidia', term: '' },
  },
  {
    name: 'Lever confirmation',
    email: { from: 'Ramp <no-reply@hire.lever.co>', subject: 'Thanks for applying to Ramp!',
      body: 'Hi Az, thank you for your interest in the Software Engineer Intern role at Ramp. https://jobs.lever.co/ramp/abc-123' },
    want: { status: 'Applied', company: 'Ramp', role: 'Software Engineer Intern', link: 'https://jobs.lever.co/ramp/abc-123' },
  },
  {
    name: 'LinkedIn Easy Apply',
    email: { from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'Az, your application was sent to Jane Street',
      body: 'Your application was sent to Jane Street\nSoftware Engineer Intern\nhttps://www.linkedin.com/jobs/view/3999999999/' },
    want: { status: 'Applied', company: 'Jane Street', link: 'https://www.linkedin.com/jobs/view/3999999999/' },
  },
  {
    name: 'Confirmation mentioning a future interview is still Applied',
    email: { from: 'Datadog Recruiting <recruiting@datadoghq.com>', subject: 'Datadog - Application Received',
      body: 'Thank you for applying! If your qualifications match, we will reach out to schedule an interview.' },
    want: { status: 'Applied', company: 'Datadog' },
  },
  {
    name: 'Rejection that also says thank you for applying',
    email: { from: 'Stripe Hiring Team <no-reply@us.greenhouse-mail.io>', subject: 'Your application to Stripe',
      body: 'Thank you for applying to Stripe. Unfortunately, we have decided to move forward with other candidates for the Software Engineering Intern, Summer 2027 position.' },
    want: { status: 'Rejected', company: 'Stripe', term: 'Summer 2027' },
  },
  {
    name: 'Interview invite',
    email: { from: 'Ramp Recruiting <recruiting@ramp.com>', subject: 'Next steps with Ramp',
      body: "Hi Az, we'd like to invite you to a phone screen for the Software Engineer Intern role. Please share your availability." },
    want: { status: 'Interview', company: 'Ramp' },
  },
  {
    name: 'HackerRank OA',
    email: { from: 'HackerRank <support@hackerrankforwork.com>', subject: 'Invitation: Two Sigma Online Assessment',
      body: 'You have been invited to take the Two Sigma online assessment.' },
    want: { status: 'Assessment', company: 'Two Sigma' },
  },
  {
    name: 'Job alert noise is ignored',
    email: { from: 'Handshake <no-reply@joinhandshake.com>', subject: '10 new jobs for you',
      body: 'Check out these jobs you may like.' },
    want: null,
  },
];

let fail = 0;
for (const c of cases) {
  const got = parseEmail({ ...c.email, date: d('2026-09-20') });
  const problems = [];
  if (c.want === null) { if (got) problems.push(`expected null, got ${JSON.stringify(got)}`); }
  else if (!got) problems.push('got null');
  else for (const k in c.want) if (got[k] !== c.want[k]) problems.push(`${k}: want ${JSON.stringify(c.want[k])}, got ${JSON.stringify(got[k])}`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);
  if (problems.length) fail++;
}

// Term detection.
const terms = [
  ['Software Engineer Intern (Summer 2027)', 'Summer 2027'],
  ["Data Science Intern - Fall '26", 'Fall 2026'],
  ['Spring Co-op 2027', 'Spring 2027'],
  ['Summer Internship 2027 - Software Engineering', 'Summer 2027'],
  ['2027 Summer Analyst Program', 'Summer 2027'],
  ['Autumn 2026 Research Intern', 'Fall 2026'],
  ['Software Engineer, New Grad 2027', 'New Grad 2027'],
  ['2027 University Graduate - Software Engineer', 'New Grad 2027'],
  ['Summer 10-week program', ''],
  ['Software Engineer Intern', ''],
];
for (const [role, want] of terms) {
  const got = extractTerm(role);
  console.log(`${got === want ? 'ok  ' : 'FAIL'} term "${role}" -> "${got}"${got === want ? '' : ` (want "${want}")`}`);
  if (got !== want) fail++;
}
const order = ['No Term', 'Fall 2026', 'Summer 2027', 'Spring 2027', 'New Grad 2027', 'Winter 2027'].sort((a, b) => termSortKey(b) - termSortKey(a));
const wantOrder = 'New Grad 2027, Summer 2027, Spring 2027, Winter 2027, Fall 2026, No Term';
console.log(`${order.join(', ') === wantOrder ? 'ok  ' : 'FAIL'} tab order: ${order.join(', ')}`);
if (order.join(', ') !== wantOrder) fail++;

// Same company + role in different terms are different applications; a term-less rejection still finds its row.
const t3 = { rows: [] };
[
  { status: 'Applied', company: 'Stripe', role: 'SWE Intern', term: 'Summer 2026', date: d('2025-09-01'), link: '', notes: '' },
  { status: 'Applied', company: 'Stripe', role: 'SWE Intern', term: 'Summer 2027', date: d('2026-09-01'), link: '', notes: '' },
  { status: 'Rejected', company: 'Stripe', role: 'SWE Intern', term: 'Summer 2027', date: d('2026-09-10'), link: '', notes: '' },
  { status: 'Interview', company: 'Ramp', role: '', term: '', date: d('2026-09-12'), link: '', notes: '' },
].forEach(p => applyToTable_(t3, p));
const s3 = t3.rows.map(r => `${r.term || 'No Term'}:${r.values.Company}:${r.values.Status}`).join(', ');
const want3 = 'Summer 2026:Stripe:Applied, Summer 2027:Stripe:Rejected, No Term:Ramp:Interview';
console.log(`${s3 === want3 ? 'ok  ' : 'FAIL'} terms keep applications separate${s3 === want3 ? '' : `\n     want ${want3}\n     got  ${s3}`}`);
if (s3 !== want3) fail++;

// Matching: confirmation -> OA -> rejection should update one row, not create three.
const table = { header: [], rows: [] };
const seq = [
  { status: 'Applied', company: 'Stripe', role: 'Software Engineering Intern', link: 'https://boards.greenhouse.io/stripe/jobs/1', date: d('2026-09-01'), notes: '' },
  { status: 'Assessment', company: 'Stripe', role: '', link: '', date: d('2026-09-05'), notes: '' },
  { status: 'Applied', company: 'Stripe', role: 'Data Science Intern', link: '', date: d('2026-09-06'), notes: '' },
  { status: 'Rejected', company: 'Stripe, Inc.', role: 'Software Engineering Intern', link: '', date: d('2026-09-10'), notes: '' },
  { status: 'Applied', company: 'Stripe', role: 'Software Engineering Intern', link: '', date: d('2026-09-11'), notes: '' }, // duplicate confirmation
];
seq.forEach(p => applyToTable_(table, p));
const summary = table.rows.map(r => `${r.values.Role}:${r.values.Status}`).join(', ');
const wantSummary = 'Software Engineering Intern:Rejected, Data Science Intern:Applied';
console.log(`${summary === wantSummary ? 'ok  ' : 'FAIL'} status updates merge into existing rows${summary === wantSummary ? '' : `\n     want ${wantSummary}\n     got  ${summary}`}`);
if (summary !== wantSummary) fail++;

// Hand-typed statuses are never overwritten.
const t2 = { header: [], rows: [{ isNew: false, dirty: new Set(), values: { Company: 'Ramp', Role: 'SWE Intern', Status: 'Withdrawn' } }] };
applyToTable_(t2, { status: 'Rejected', company: 'Ramp', role: 'SWE Intern', link: '', date: d('2026-09-12'), notes: '' });
const kept = t2.rows[0].values.Status === 'Withdrawn';
console.log(`${kept ? 'ok  ' : 'FAIL'} hand-typed status is left alone`);
if (!kept) fail++;

console.log('\nquery length:', buildQuery('newer_than:2d').length, 'chars');
console.log(fail ? `\n${fail} failing` : '\nall passing');
process.exit(fail ? 1 : 0);
