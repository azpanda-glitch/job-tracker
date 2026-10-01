/**
 * Job Application Tracker
 *
 * Scans your Gmail for application confirmations and status updates (assessment,
 * interview, rejection, offer) and logs them to the Google Sheet this script is
 * bound to, with one tab per term ("Summer 2027", "Fall 2026", "New Grad 2027", ...).
 * Applications with no term in the role or email go to the "No Term" tab.
 *
 * Setup: open your Sheet > Extensions > Apps Script, paste this file, save, and
 * run setup() once. It backfills the last year (in chunks that resume on their
 * own, since Apps Script stops runs at 6 minutes) and then scans hourly.
 */

const CONFIG = {
  NO_TERM_SHEET_NAME: 'No Term',
  SEEN_SHEET_NAME: '_seen',
  SKIPPED_SHEET_NAME: '_skipped',
  MAX_SKIPPED: 500,          // newest kept; older rows are trimmed
  SCAN_DAYS: 2,            // hourly scans look back this far; overlap is fine, messages are deduped by ID
  BACKFILL_DAYS: 365,
  BACKFILL_WINDOW_DAYS: 14,  // backfill walks the year oldest-first in slices this size
  MAX_THREADS: 2000,         // per search; a slice or 2-day scan won't come close
  MAX_RUN_MS: 4.5 * 60 * 1000, // Apps Script kills runs at 6 min; stop early and save progress
  MERGE_WINDOW_DAYS: 3,    // a role-less confirmation within this many days of another from the same company is a duplicate
  // Only emails this recent get their posting looked up. Older postings are
  // usually closed, so a lookup during the backfill would mostly find nothing.
  LOOKUP_DAYS: 7,
  // Optional: a Google Programmable Search key and engine ID, used when the
  // company's job board isn't on Greenhouse, Lever, or Ashby. Leave blank to skip.
  SEARCH_API_KEY: '',
  SEARCH_ENGINE_ID: '',
};

const HEADERS = ['Company', 'Role', 'Status', 'Date Applied', 'Last Update', 'Posting Link', 'Source', 'Email', 'Notes'];

const STATUSES = ['Applied', 'Assessment', 'Interview', 'Rejected', 'Offer'];

// A new status only replaces the current one if it ranks higher. Statuses you
// type by hand (e.g. "Withdrawn", "Ghosted") aren't listed, so they're never overwritten.
const STATUS_RANK = { Applied: 1, Assessment: 2, Interview: 3, Rejected: 3.5, Offer: 4 };

const STATUS_COLORS = {
  Applied: '#e8f0fe',
  Assessment: '#fef7e0',
  Interview: '#e6f4ea',
  Rejected: '#fce8e6',
  Offer: '#ceead6',
};

// Applicant tracking systems and assessment platforms that send confirmations.
const ATS_DOMAINS = [
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'myworkday.com', 'myworkdayjobs.com',
  'ashbyhq.com', 'smartrecruiters.com', 'icims.com', 'jobvite.com', 'taleo.net',
  'successfactors.com', 'workablemail.com', 'workable.com', 'bamboohr.com', 'amazon.jobs',
  'hackerrank.com', 'hackerrankforwork.com', 'codesignal.com', 'codility.com', 'hirevue.com', 'joinhandshake.com',
  'linkedin.com', 'eightfold.ai', 'avature.net', 'oraclecloud.com', 'dayforcehcm.com',
];

// Recruiting tools that email on behalf of many employers: scheduling, chatbots,
// assessments, CRMs, job boards. Their domain and display name ("Olivia",
// "Interview Scheduling") never name the employer, and treating them as the
// company merged applications at different employers into one row.
const RECRUITING_TOOL_DOMAINS = [
  'paradox.ai', 'gem.com', 'goodtime.io', 'modernloop.io', 'yello.co', 'beamery.com',
  'phenompeople.com', 'phenom.com', 'applytojob.com', 'jazzhr.com', 'recruitee.com',
  'teamtailor.com', 'teamtailor-mail.com', 'rippling.com', 'ultipro.com', 'ukg.com',
  'brassring.com', 'csod.com', 'paylocity.com', 'adp.com', 'breezy.hr', 'pinpointhq.com',
  'dover.com', 'wellfound.com', 'angel.co', 'indeed.com', 'indeedemail.com',
  'ziprecruiter.com', 'glassdoor.com', 'ripplematch.com', 'wayup.com', 'symplicity.com',
  '12twenty.com', 'calendly.com', 'modernhire.com', 'pymetrics.ai', 'harver.com',
  'karat.io', 'karat.com', 'coderbyte.com', 'testgorilla.com', 'mettl.com', 'shl.com',
  'criteriacorp.com', 'otta.com', 'welcometothejungle.com', 'simplify.jobs',
];

// The only senders that put the employer in the local part
// (<company>@myworkday.com, <company>@talent.icims.com). Elsewhere the local part
// is a person or a mailbox name.
const EMPLOYER_IN_LOCAL_DOMAINS = ['myworkday.com', 'myworkdayjobs.com', 'icims.com'];

const RECRUITING_DOMAINS = ATS_DOMAINS.concat(RECRUITING_TOOL_DOMAINS);

const isRecruitingDomain_ = domain => RECRUITING_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
const isToolDomain_ = domain => RECRUITING_TOOL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));

// Words that make a two- or three-word name a company rather than a person.
const COMPANY_WORDS = /\b(inc|llc|ltd|corp|corporation|co|company|labs?|technolog(y|ies)|tech|bank|capital|group|partners|systems|solutions|health(care)?|software|studios?|games|ai|financial|securities|holdings|street|sigma|research|robotics|motors|energy|foods?|media|networks?|analytics|ventures|consulting|insurance|airlines?|pharma(ceuticals)?|bio|therapeutics|university|college|institute|foundation|management|advisors|associates|trading|markets|payments|cloud|data|digital|mobile|global|international|americas?|brands|entertainment|interactive|industries|aerospace|defense|dynamics|electric|automotive|logistics|realty|properties|investments|asset|fund|express)\b/i;

const SUBJECT_PHRASES = [
  'thank you for applying', 'thanks for applying', 'thank you for your application',
  'thank you for your interest', 'application received', 'received your application',
  'application was sent', 'application submitted', 'your application', 'application update',
  'interview invitation', 'invitation to interview', 'online assessment', 'coding assessment',
  // Broad catch for postings whose confirmation says nothing else recognizable.
  'intern', 'internship', 'co-op', 'new grad',
];

// Searched anywhere in the message, not just the subject. Rejections are the
// emails most likely to come from a plain recruiter address with a vague
// subject ("Update on your candidacy"), so the body is what identifies them.
const BODY_PHRASES = [
  'unfortunately', 'regret to inform', 'not be moving forward', 'other candidates',
  'no longer being considered', 'not selected',
];

const NOISE_SUBJECTS = ['job alert', 'jobs you may', 'recommended jobs', 'new jobs', 'jobs for you', 'is hiring'];

// Sender names that are the ATS itself, not the employer.
const GENERIC_SENDERS = [
  'workday', 'greenhouse', 'lever', 'ashby', 'icims', 'smartrecruiters', 'jobvite', 'taleo',
  'successfactors', 'workable', 'bamboohr', 'linkedin', 'hackerrank', 'codesignal', 'codility',
  'hirevue', 'handshake', 'indeed', 'eightfold', 'avature', 'oracle', 'dayforce',
];

// Local parts that are the mailer, not the employer. Matched as a substring, so
// "jobs-noreply" and "talent-acquisition" are caught too.
const GENERIC_LOCAL = /no-?reply|do-?not-?reply|notification|unsubscribe|support|help|info|hello|contact|career|job|talent|recruit|hiring|^hr$|people|team|mail|alert|update|apply|application|candidate|auto|system|admin|service|inbox|message|survey|feedback/i;

// Two-level public suffixes, so acme.co.uk reads as "acme", not "co".
const MULTI_SUFFIX = /\.(co|com|net|org|ac|gov|edu|gob|or)\.[a-z]{2,3}$/;

// Trailing words a company bolts onto its domain. Stripped only when enough of
// the name is left ("datadoghq" -> Datadog, but "gmail" stays Gmail).
const DOMAIN_SUFFIX = /(hq|inc|corp|group|global|holdings|careers?|jobs?|talent|hiring|recruiting|mail|email)$/;

// Personal mailboxes: a recruiter writing from one tells you nothing about the
// employer, so the company has to come from the subject or body instead.
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|zoho|fastmail|yandex|mail|email|inbox|qq|163|126|naver|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink)$/;

// Domains whose company name can't be recovered by capitalizing. Add your own.
const DOMAIN_COMPANY_NAMES = {
  gs: 'Goldman Sachs', ms: 'Morgan Stanley', jpmchase: 'JPMorgan Chase', bofa: 'Bank of America',
  goldmansachs: 'Goldman Sachs', jpmorgan: 'JPMorgan Chase', jpmorganchase: 'JPMorgan Chase',
  morganstanley: 'Morgan Stanley', bankofamerica: 'Bank of America', wellsfargo: 'Wells Fargo',
  janestreet: 'Jane Street', twosigma: 'Two Sigma', capitalone: 'Capital One',
  statefarm: 'State Farm', generalmotors: 'General Motors', lockheedmartin: 'Lockheed Martin',
  americanexpress: 'American Express', deshaw: 'D. E. Shaw', citadelsecurities: 'Citadel Securities',
  hubspot: 'HubSpot', paypal: 'PayPal', linkedin: 'LinkedIn', github: 'GitHub', nvidia: 'NVIDIA',
  ibm: 'IBM', sap: 'SAP', ey: 'EY', pwc: 'PwC', kpmg: 'KPMG', bcg: 'BCG', tiktok: 'TikTok',
  doordash: 'DoorDash', youtube: 'YouTube', openai: 'OpenAI', anthropic: 'Anthropic',
};

// Words that mean a captured "company" is actually a job title.
const JOB_WORDS = /\b(engineer(ing)?|intern(ship)?|developer|analyst|scientist|manager|position|role|software|program|summer|fall|spring|winter|co-?op|associate|specialist|designer|new grad|graduate|team|job)\b/i;

// "will not"/"won't"/"cannot" and friends.
const NEG = '(?:(?:will|would|can|could|shall)\\s*not|(?:wo|wou?ld|ca|cou?ld|sha)n[\\u2019\\u0027]?t)';

// Rules out conditional next steps ("can't move forward until you finish the OA").
const NOT_CONDITIONAL = '(?![^.]{0,60}\\b(?:until|unless|without|pending|once\\s+you|as\\s+soon\\s+as|if\\s+you|when\\s+you)\\b)';

const STATUS_PATTERNS = [
  // Checked in this order: rejections often also say "thank you for applying".
  ['Offer', /\b(pleased to offer|offer letter|extend (you )?an offer|offer of employment|congratulations[^.]{0,60}\boffer)\b/i],
  // "Move forward" is also how good news is phrased ("we'd like to move forward
  // with your application"), so every variant here needs either a negation or
  // "with other candidates" -- never "move forward" on its own. Negations also
  // carry NOT_CONDITIONAL, because "we can't move forward until you finish the
  // assessment" is a next step, not a rejection.
  ['Rejected', new RegExp([
    'regret to inform',
    'mov(?:e|ing|ed)\\s+(?:you\\s+)?(?:forward|ahead)\\s+with\\s+(?:other|another|a\\s+different|different)',
    '(?:decided|chosen|elected|opted)\\s+to\\s+(?:pursue|proceed\\s+with|go\\s+with|interview)\\s+(?:other|another|different)',
    '(?:decided|chosen|elected|opted)\\s+not\\s+to\\s+(?:move|proceed|continue|advance)',
    NEG + '\\s+(?:be\\s+)?(?:able\\s+to\\s+)?(?:mov|proceed|progress|continu|advanc)' + NOT_CONDITIONAL,
    '(?:are|is|was|were|am)\\s+(?:not|un)\\s?able\\s+to\\s+(?:move|proceed|offer|progress|advance)' + NOT_CONDITIONAL,
    'not\\s+(?:be\\s+)?(?:moving|proceeding|progressing|advancing|continuing)' + NOT_CONDITIONAL,
    'not\\s+(?:to\\s+)?(?:be\\s+)?mov(?:e|ing)\\s+forward' + NOT_CONDITIONAL,
    'no\\s+longer\\s+(?:being\\s+|under\\s+)?consider',
    '(?:were|was|have|has|are|is)\\s+not\\s+(?:been\\s+)?(?:select|chos|success)',
    'not\\s+(?:been\\s+)?(?:selected|chosen|successful)',
    '(?:position|role|req(?:uisition)?)\\s+(?:has\\s+been|was|is)\\s+(?:now\\s+)?(?:filled|closed)',
    '(?:have|has|we[\\u2019\\u0027]ve)\\s+(?:now\\s+)?filled\\s+(?:the|this)',
    'pursue\\s+other\\s+(?:candidates|applicants)',
    'other\\s+(?:candidates|applicants)\\s+whose',
    '(?:not|un)able\\s+to\\s+offer\\s+you',
    'application\\s+(?:was|has\\s+been)\\s+(?:not\\s+successful|unsuccessful)',
    'was\\s+not\\s+successful'
  ].join('|'), 'i')],
  ['Interview', /\b(invite you to (an? )?(interview|phone screen|virtual interview|onsite)|like to (schedule|invite you|move you forward)|interview invitation|invitation to interview|(provide|share|send) (us )?your availability|next round of interview|(please|click (here )?to|use (the|this) link (below )?to) schedule (your|an|a) (interview|phone screen))/i],
  ['Assessment', /\b(online assessment|coding (challenge|assessment|test)|take[- ]home|assessment invitation|invited to (take|complete)|complete (the|an|this|our) (online )?(assessment|challenge)|hackerrank|codesignal|codility)\b/i],
  ['Applied', /\b(thank(s| you) for (your )?(applying|application|interest|submitting)|application (has been |was )?(received|submitted|sent)|received your application|successfully (submitted|applied)|your application (to|for|at))/i],
];

const JOB_LINK_PATTERNS = [
  /greenhouse\.io\/[^\s]*jobs?\//i,
  /jobs\.lever\.co\//i,
  /myworkdayjobs\.com\/[^\s]*job\//i,
  /jobs\.ashbyhq\.com\//i,
  /smartrecruiters\.com\/[^\s]*\d/i,
  /linkedin\.com\/jobs\/view\//i,
  /amazon\.jobs\/[^\s]*jobs\//i,
  /icims\.com\/jobs\//i,
  /\/(careers?|jobs?)\/[^\s]*\d{4,}/i,
];

// ---------- Entry points ----------

function setup() {
  clearTriggers_('scanNow');
  ScriptApp.newTrigger('scanNow').timeBased().everyHours(1).create();
  backfill();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Job Tracker')
    .addItem('Scan now', 'scanNow')
    .addItem('Backfill last 12 months', 'backfill')
    .addSeparator()
    .addItem('Show skipped emails', 'showSkipped')
    .addToUi();
}

function scanNow() {
  scan_(`newer_than:${CONFIG.SCAN_DAYS}d`, Date.now() - CONFIG.SCAN_DAYS * 864e5, Date.now());
}

/** Starts (or restarts) the backfill from BACKFILL_DAYS ago. Already-logged emails are skipped. */
function backfill() {
  PropertiesService.getScriptProperties().setProperties({
    backfillCursor: String(Date.now() - CONFIG.BACKFILL_DAYS * 864e5),
    backfillUntil: String(Date.now()),
  });
  continueBackfill();
}

/**
 * Works through the backfill one slice at a time, oldest first. When a run is
 * about to hit the time limit it schedules itself to pick up where it left off.
 */
function continueBackfill() {
  clearTriggers_('continueBackfill');
  const props = PropertiesService.getScriptProperties();
  let cursor = Number(props.getProperty('backfillCursor'));
  const until = Number(props.getProperty('backfillUntil'));
  if (!cursor || !until) return;

  const started = Date.now();
  while (cursor < until) {
    const end = Math.min(cursor + CONFIG.BACKFILL_WINDOW_DAYS * 864e5, until);
    // Gmail's after:/before: are whole days; the extra day of overlap is deduped by message ID.
    const query = `after:${gmailDate_(cursor)} before:${gmailDate_(end + 864e5)}`;
    if (!scan_(query, cursor, started)) break; // out of time (or another scan holds the lock)
    cursor = end;
    props.setProperty('backfillCursor', String(cursor));
  }

  if (cursor < until) {
    console.log(`Backfill paused at ${new Date(cursor).toDateString()}; resuming in 1 minute`);
    ScriptApp.newTrigger('continueBackfill').timeBased().after(60 * 1000).create();
  } else {
    props.deleteProperty('backfillCursor');
    props.deleteProperty('backfillUntil');
    console.log('Backfill complete');
  }
}

function clearTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function gmailDate_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

// ---------- Scan ----------

/**
 * Processes every not-yet-seen message dated on/after sinceMs in threads matching
 * the time clause. Returns true if it finished, false if it stopped early (time
 * limit or lock busy); progress is saved either way.
 */
function scan_(timeClause, sinceMs, started) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return false; // another scan is running
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const seen = loadSeen_(ss);
    const table = readTables_(ss);
    const me = Session.getActiveUser().getEmail().toLowerCase();
    const outOfTime = () => Date.now() - started > CONFIG.MAX_RUN_MS;

    const messages = [];
    const threads = new Map();
    for (const q of buildQueries(timeClause)) {
      for (const th of searchThreads_(q)) threads.set(th.getId(), th);
      if (outOfTime()) return false;
    }
    for (const thread of threads.values()) {
      if (outOfTime()) return false;
      // Later messages in a thread (e.g. a rejection reply) are included even if
      // they fall after this slice, since they may not match the search on their own.
      thread.getMessages().forEach(m => {
        if (seen.has(m.getId()) || m.getDate().getTime() < sinceMs) return;
        if (me && m.getFrom().toLowerCase().includes(me)) return; // your own replies
        messages.push(m);
      });
    }
    // Oldest first so a thread's statuses progress in order.
    messages.sort((a, b) => a.getDate() - b.getDate());

    const newSeen = [];
    const skipped = [];
    const boards = {}; // company -> open jobs, fetched at most once per run
    let finished = true;
    for (const m of messages) {
      if (outOfTime()) { finished = false; break; } // the rest gets picked up next run
      newSeen.push(m.getId());
      const parsed = parseEmail({
        from: m.getFrom(),
        subject: m.getSubject(),
        body: m.getPlainBody(),
        html: m.getBody(),
        date: m.getDate(),
        replyTo: m.getReplyTo(),
      });
      if (!parsed) {
        if (worthReviewing_(m.getFrom(), m.getSubject())) skipped.push([m.getDate(), m.getFrom(), m.getSubject()]);
        continue;
      }
      parsed.threadUrl = 'https://mail.google.com/mail/#all/' + m.getThread().getId();
      if (parsed.needsLookup && Date.now() - m.getDate().getTime() <= CONFIG.LOOKUP_DAYS * 864e5) {
        const found = findPostingLink_(parsed.company, parsed.role, boards);
        if (found) {
          parsed.link = found;
          parsed.notes = parsed.notes.replace(/;?\s*Posting link is a search/, '').replace(/^;\s*/, '');
        }
      }
      applyToTable_(table, parsed);
    }

    writeTables_(ss, table);
    saveSeen_(ss, newSeen);
    saveSkipped_(ss, skipped);
    return finished;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Several short Gmail searches instead of one long one. Gmail doesn't document
 * a length limit for a query, and a single ~2,000-character OR-chain is exactly
 * the kind of thing that can quietly stop matching. Results are merged by thread.
 */
function buildQueries(timeClause) {
  const quote = list => list.map(p => `"${p}"`).join(' OR ');
  const noise = `-subject:(${quote(NOISE_SUBJECTS)})`;
  const queries = [];
  for (let i = 0; i < RECRUITING_DOMAINS.length; i += 20) {
    queries.push(`from:(${RECRUITING_DOMAINS.slice(i, i + 20).join(' OR ')}) ${noise} ${timeClause}`);
  }
  queries.push(`subject:(${quote(SUBJECT_PHRASES)}) ${noise} ${timeClause}`);
  // Body wording only counts alongside an application word: "unfortunately" on
  // its own matched enough newsletters to slow the backfill to a crawl.
  queries.push(`(${quote(BODY_PHRASES)}) (application OR candidacy OR position OR role OR interest) ${noise} ${timeClause}`);
  return queries;
}

function searchThreads_(query) {
  const threads = [];
  for (let start = 0; start < CONFIG.MAX_THREADS; start += 100) {
    const page = GmailApp.search(query, start, 100);
    threads.push(...page);
    if (page.length < 100) break;
  }
  return threads;
}

// ---------- Parsing (pure; no Apps Script services) ----------

/**
 * Returns {status, company, role, term, link, source, date, notes} or null if the
 * email isn't an application email.
 */
function parseEmail({ from, subject, body, html, date, replyTo }) {
  subject = (subject || '')
    .replace(/^\s*((re|fwd?):\s*)+/i, '')
    .replace(/^\s*(invitation|reminder|action required|update|important|next steps)\s*[:–-]\s*/i, '')
    .trim();
  body = (body || '').slice(0, 6000);
  const text = subject + '\n' + body;

  const status = classifyStatus(text);
  if (!status) return null;

  const company = extractCompany(subject, body, from || '', replyTo || '');
  const role = extractRole(subject, body);
  const term = extractTerm(role, subject, body.slice(0, 3000));
  let link = extractJobLink(body + '\n' + (html || ''));
  const notes = [];
  if (!company || !role) notes.push('Needs review: couldn\'t read ' + [!company && 'company', !role && 'role'].filter(Boolean).join(' / '));
  else if (company === personSenderName_(from || '')) notes.push('Needs review: company may be the recruiter\'s name');
  const needsLookup = !link && !!company;
  if (needsLookup) {
    link = 'https://www.google.com/search?q=' + encodeURIComponent([company, role, 'careers'].filter(Boolean).join(' '));
    notes.push('Posting link is a search');
  }

  return { status, company, role, term, link, needsLookup, source: sourceOf(from || ''), date, notes: notes.join('; ') };
}

// Confirmation boilerplate that reads like a rejection out of context:
// "If you are not selected, we'll keep your resume on file", "we'll update you
// once the position has been filled". Removed before classifying.
const CONDITIONAL_REJECTION = new RegExp([
  '\\b(?:if|in\\s+case|in\\s+the\\s+event(?:\\s+that)?|should)\\s+(?:you\\s+(?:are|were|aren[\\u2019\\u0027]t)|you[\\u2019\\u0027]re)\\s+not\\s+(?:selected|chosen|moved|moving|successful)[^.!?\\n]*',
  '\\b(?:once|when|until|after|before|if)\\s+(?:the|this|a|our)\\s+(?:position|role|req(?:uisition)?|opening)\\s+(?:has\\s+been|is|was|gets|have\\s+been)\\s+(?:filled|closed)[^.!?\\n]*',
].join('|'), 'gi');

function classifyStatus(text) {
  const t = String(text || '').replace(CONDITIONAL_REJECTION, ' ');
  for (const [status, re] of STATUS_PATTERNS) if (re.test(t)) return status;
  return null;
}

// A run of 1–5 capitalized words, e.g. "Stripe", "Jane Street", "JPMorgan Chase & Co".
const CAP_RUN = "([A-Z0-9][\\w&.'’-]*(?:[ ](?:[A-Z0-9&][\\w&.'’-]*|of|and|de)){0,4})";

function extractCompany(subject, body, from, replyTo) {
  const head = body.slice(0, 2000);
  const candidates = [
    match_(subject, /application (?:was |has been )?sent to (.+)$/i),                        // LinkedIn Easy Apply
    match_(subject, new RegExp("\\b(?:appl(?:y|ying|ication)|interest|position|role|opening|internship)\\b[^!?\\n]{0,80}?[ ](?:at|with)[ ]+" + CAP_RUN)),
    match_(subject, new RegExp("\\b(?:appl(?:y|ying|ication)|interest)[ ]+(?:to|in|with|at)[ ]+" + CAP_RUN)),
    match_(subject, new RegExp('^' + CAP_RUN + '[ ]*[-–|:]')),                              // "Stripe - Application Received"
    match_(subject, new RegExp(CAP_RUN.replace('{0,4})', '{0,4}?)') + '[ ]+(?:[Oo]nline [Aa]ssessment|[Cc]oding [Cc]hallenge|[Aa]ssessment|[Ii]nterview)')), // "Two Sigma Online Assessment"
    companyFromSenderName_(from),
    // The sending domain outranks anything scraped out of the body: a company
    // that mails you from its own domain has already named itself.
    companyFromSenderAddress_(from),
    // ATS mail often sets Reply-To to the employer's own recruiter.
    companyFromSenderAddress_(replyTo || ''),
    match_(head, new RegExp("\\b(?:appl(?:y|ying|ication)|interest|position|role|opening|internship)\\b[^!?\\n]{0,80}?[ ](?:at|with)[ ]+" + CAP_RUN)),
    match_(head, new RegExp("\\b(?:appl(?:y|ying|ication)|interest)[ ]+(?:to|in|with|at)[ ]+" + CAP_RUN)),
    // Last resort: a person-looking name on ATS mail. Sometimes it really is the
    // company ("Two Sigma <no-reply@greenhouse.io>"); parseEmail flags the row.
    personSenderName_(from),
  ];
  for (const c of candidates) {
    const cleaned = cleanCompany_(c);
    if (cleaned) return cleaned;
  }
  return '';
}

function cleanCompany_(s) {
  if (!s) return '';
  s = s.replace(/[\s.,!:;|–-]+$/, '').replace(/^the\s+/i, '').replace(/['’]s$/, '').trim();
  // Drop trailing words that start the next sentence/clause.
  s = s.replace(/\s+(We|Our|This|Your|You|I|Hi|Hello|Thank|Thanks|Team|Careers|Recruiting)\b.*$/, '').trim();
  if (!s || s.length > 50 || JOB_WORDS.test(s)) return '';
  // A stray pronoun ("...for your interest in Us") is not a company.
  if (/^(us|we|you|your|our|the|this|that|it|they|them|here|there|all)$/i.test(s)) return '';
  if (GENERIC_SENDERS.includes(s.toLowerCase())) return '';
  return s;
}

function senderAddress_(from) {
  return (((from.match(/<([^>]+)>/) || [])[1] || from).trim().toLowerCase());
}

function senderDomain_(from) {
  return senderAddress_(from).split('@')[1] || '';
}

/** The display name with recruiting words removed: "Stripe Hiring Team" -> "Stripe". */
function senderDisplayName_(from) {
  let name = (from.match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || '';
  // "Priya at Figma", "Jordan from Ramp": the employer is named outright.
  const via = name.match(/\b(?:from|at|@)\s+(.+)$/i);
  if (via) name = via[1];
  name = name
    .replace(/\b(university recruiting|campus recruiting|talent acquisition|hiring team|recruiting team|recruitment|recruiting|careers?|talent|hiring|jobs|team|hr|people|no-?reply|notifications?|via \w+)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || /@/.test(name)) return { name: '', via: false };
  if (GENERIC_SENDERS.some(g => name.toLowerCase().includes(g))) return { name: '', via: false };
  return { name, via: !!via };
}

/** "Priya Raman", "Jordan K. Lee" -- but not "Two Sigma Investments" or "Stripe". */
function looksLikePerson_(name) {
  const tokens = name.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (COMPANY_WORDS.test(name)) return false;
  return tokens.every(w => /^[A-Z][a-z\u00e0-\u00ff'\u2019-]+$/.test(w) || /^[A-Z]\.?$/.test(w));
}

/**
 * The company from the sender's display name, or '' when that name is a person
 * or a tool rather than the employer.
 */
function companyFromSenderName_(from) {
  const { name, via } = senderDisplayName_(from);
  if (!name) return '';
  if (via) return name;
  const domain = senderDomain_(from);
  // Scheduling tools and chatbots: the display name is a bot or a coordinator.
  if (isToolDomain_(domain)) return '';
  if (domain && !isRecruitingDomain_(domain) && !FREE_MAIL.test(domainBase_(domain))) {
    // A company's own domain already names the employer. The display name only
    // wins when it isn't a person, or when it's the same name better spelled
    // ("Jane Street" for janestreet.com).
    const base = domainBase_(domain).replace(/[^a-z0-9]/g, '');
    const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const sameAsDomain = flat.length >= 3 && (flat === base || base.startsWith(flat) || flat.startsWith(base));
    return sameAsDomain || !looksLikePerson_(name) ? name : '';
  }
  // ATS or personal mailbox: a person's name says nothing about the employer.
  return looksLikePerson_(name) ? '' : name;
}

/** The person-looking ATS display name that companyFromSenderName_ held back. */
function personSenderName_(from) {
  const domain = senderDomain_(from);
  if (!domain || isToolDomain_(domain) || !isRecruitingDomain_(domain)) return '';
  const { name, via } = senderDisplayName_(from);
  return !via && name && looksLikePerson_(name) ? name : '';
}

/**
 * The company implied by an email address. For a company's own domain that's the
 * domain itself; for an ATS it's the local part, which is where several of them
 * put the employer (<company>@myworkday.com, <company>@talent.icims.com).
 */
function companyFromSenderAddress_(from) {
  const [local, domain] = senderAddress_(from).split('@');
  if (!domain || !local) return '';
  if (isRecruitingDomain_(domain)) {
    if (!EMPLOYER_IN_LOCAL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return '';
    // A generic or dotted local part is a mailbox or a person, not the employer.
    return GENERIC_LOCAL.test(local) || /[._]/.test(local) ? '' : companyFromWord_(local);
  }
  const base = domainBase_(domain);
  return FREE_MAIL.test(base) ? '' : companyFromWord_(base);
}

/** "careers.acme.co.uk" -> "acme", "mail.figma.com" -> "figma" */
function domainBase_(domain) {
  const stripped = MULTI_SUFFIX.test(domain)
    ? domain.replace(MULTI_SUFFIX, '')
    : domain.replace(/\.[a-z]{2,}$/, '');
  const parts = stripped.split('.');
  return parts[parts.length - 1] || '';
}

/** "datadoghq" -> "Datadog", "goldmansachs" -> "Goldman Sachs" */
function companyFromWord_(word) {
  const key = word.replace(/[^a-z0-9]/g, '');
  if (!key || key.length < 2) return '';
  if (DOMAIN_COMPANY_NAMES[key]) return DOMAIN_COMPANY_NAMES[key];
  const trimmed = key.replace(DOMAIN_SUFFIX, '');
  const base = trimmed.length >= 3 ? trimmed : key;
  return DOMAIN_COMPANY_NAMES[base] || titleCase_(base);
}

function extractRole(subject, body) {
  const head = body.slice(0, 3000);
  const patterns = [
    /\b(?:for|to|in)\s+(?:the|our|a|an)\s+([^\n!?]{3,100}?)\s+(?:position|role|opening|opportunity|job)\b/i,
    /\b(?:applying|application|applied|interest)\s+(?:for|to|in)\s+(?:the\s+|our\s+)?([^\n!?]{3,100}?)\s+(?:at|with)\s+[A-Z]/,
    /(?:^|\n)\s*(?:position|role|job title|job|requisition)\s*:\s*([^\n]{3,100})/i,
    /application (?:for|to)\s+(?:the\s+)?([^\n!?]{3,100}?)\s*(?:[-–|(]|$)/i,
  ];
  for (const src of [subject, head]) {
    for (const re of patterns) {
      const role = cleanRole_(match_(src, re));
      if (role) return role;
    }
  }
  return '';
}

function cleanRole_(s) {
  if (!s) return '';
  s = s.replace(/\s+/g, ' ').replace(/^(the|our|a|an)\s+/i, '').replace(/[\s.,:;–-]+$/, '').trim();
  if (s.length < 3 || s.length > 100 || /https?:|@/.test(s) || s.split(' ').length > 15) return '';
  // Needs to look like a title, not prose ("it", "this", "us").
  if (!/[A-Z]/.test(s) || /^(it|this|us|you|them)$/i.test(s)) return '';
  return s;
}

const SEASONS = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall', autumn: 'Fall' };
const SEASON_ORDER = { Winter: 1, Spring: 2, Summer: 3, Fall: 4, 'New Grad': 5 };

/**
 * "Summer 2027", "Fall 2026", "New Grad 2027", "2027", or '' -- from the first
 * text that names one.
 *
 * Titles rarely put the season next to the year ("Finance Summer Analyst 2027",
 * "Summer Analyst Intern (2026)"), so a gap of non-digit words is allowed
 * between them. When only a year appears next to an internship word
 * ("SWE Intern 2027"), the year alone is the term -- guessing a season would be
 * wrong as often as it was right, and a bare-year tab still beats "No Term".
 */
function extractTerm(...texts) {
  const YEAR4 = "'?(20[2-3]\\d)\\b";
  const YEAR = "'?(20[2-3]\\d|2[4-9]|3\\d)\\b";
  const SEASON = "(summer|spring|fall|autumn|winter)";
  const GRAD = "(new grad(?:uate)?|university grad(?:uate)?|early career)";
  const CYCLE = "(?:intern(?:ship)?s?|co-?op|analyst|program|term|cycle)";
  // No digits in the gap, so a match can't jump over another number.
  const GAP = "[^\\d\\n]{0,30}?";
  const patterns = [
    // Season then year, adjacent or a few words apart.
    // (?![a-z]) rather than \b so "Summer2026" still matches.
    [new RegExp("\\b" + SEASON + "(?![a-z])" + GAP + YEAR, 'i'), m => [SEASONS[m[1].toLowerCase()], m[2]]],
    // Year then season.
    [new RegExp("\\b" + YEAR4 + GAP + SEASON + "\\b", 'i'), m => [SEASONS[m[2].toLowerCase()], m[1]]],
    [new RegExp("\\b" + GRAD + "\\b" + GAP + YEAR4, 'i'), m => ['New Grad', m[2]]],
    [new RegExp("\\b" + YEAR4 + GAP + GRAD + "\\b", 'i'), m => ['New Grad', m[1]]],
    // Year with no season, next to an internship/co-op word.
    [new RegExp("\\b" + CYCLE + "\\b" + GAP + YEAR4, 'i'), m => ['', m[1]]],
    [new RegExp("\\b" + YEAR4 + GAP + CYCLE + "\\b", 'i'), m => ['', m[1]]],
  ];
  for (const t of texts) {
    if (!t) continue;
    for (const [re, pick] of patterns) {
      const m = t.match(re);
      if (!m) continue;
      const [season, y] = pick(m);
      const year = y.length === 2 ? '20' + y : y;
      return season ? `${season} ${year}` : year;
    }
  }
  return '';
}

/** Sorts term tabs newest first; "No Term" and other tabs last. */
function termSortKey(name) {
  const m = (name || '').match(/^(Winter|Spring|Summer|Fall|New Grad) (\d{4})$/);
  if (m) return Number(m[2]) * 10 + SEASON_ORDER[m[1]];
  // A bare-year tab ("2027") sorts just below that year's seasons.
  const y = (name || '').match(/^(20[2-3]\d)$/);
  return y ? Number(y[1]) * 10 : -1;
}

function isTermName_(name) { return termSortKey(name) > 0; }

function extractJobLink(text) {
  const urls = (text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])
    .map(u => u.replace(/&amp;/g, '&').replace(/[.,;]+$/, ''))
    .filter(u => !/unsubscribe|privacy|preferences|opt-?out|\.(png|jpe?g|gif)(\?|$)/i.test(u));
  for (const re of JOB_LINK_PATTERNS) {
    const hit = urls.find(u => re.test(u));
    if (hit) return hit;
  }
  return '';
}

function sourceOf(from) {
  const f = from.toLowerCase();
  const names = {
    greenhouse: 'Greenhouse', lever: 'Lever', workday: 'Workday', ashby: 'Ashby',
    smartrecruiters: 'SmartRecruiters', icims: 'iCIMS', jobvite: 'Jobvite', taleo: 'Taleo',
    linkedin: 'LinkedIn', hackerrank: 'HackerRank', codesignal: 'CodeSignal', handshake: 'Handshake',
    workable: 'Workable', successfactors: 'SuccessFactors', 'amazon.jobs': 'Amazon Jobs',
  };
  for (const k in names) if (f.includes(k)) return names[k];
  return 'Direct';
}

function match_(s, re) {
  const m = (s || '').match(re);
  return m ? m[1].trim() : '';
}

function titleCase_(s) {
  return s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// ---------- Posting lookup ----------

/** Board slugs to try: "Jane Street" -> ["janestreet", "jane-street"]. */
function boardSlugs(company) {
  const words = normCompany(company) ? company.toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\.?/g, '')
    .match(/[a-z0-9]+/g) || [] : [];
  if (!words.length) return [];
  return [...new Set([words.join(''), words.join('-')])];
}

const ROLE_STOPWORDS = /^(the|a|an|and|of|for|to|in|at|with|-|summer|fall|spring|winter|autumn|20\d\d|\d+|remote|hybrid|onsite|us|usa)$/;

// The same job is written several ways across the email and the posting.
const ROLE_SYNONYMS = { engineering: 'engineer', internship: 'intern', interns: 'intern', coop: 'intern',
  developer: 'engineer', swe: 'engineer', sde: 'engineer', mgr: 'manager', pm: 'manager' };

function roleTokens_(s) {
  return (s || '').toLowerCase().replace(/\bco-op\b/g, 'coop').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(w => w && !ROLE_STOPWORDS.test(w))
    .map(w => ROLE_SYNONYMS[w] || w);
}

/**
 * The open job that best matches the role, or null. Every meaningful word of the
 * role has to be in the title (so "Software Engineer Intern" never lands on a
 * full-time "Senior Software Engineer"), and a role-less row matches nothing --
 * a company's careers page is no better than the search link already there.
 */
function bestJobMatch(jobs, role) {
  const want = roleTokens_(role);
  if (!want.length) return null;
  const isIntern = want.includes('intern');
  let best = null;
  for (const job of jobs) {
    const have = new Set(roleTokens_(job.title));
    if (isIntern && !have.has('intern')) continue;
    const hits = want.filter(w => have.has(w)).length;
    if (hits < want.length) continue;
    // Prefer the tightest title: fewer extra words beyond the role.
    const extra = have.size - hits;
    if (!best || extra < best.extra) best = { url: job.url, extra };
  }
  return best ? best.url : null;
}

/** Open jobs from the public Greenhouse, Lever, and Ashby boards, as [{title, url}]. */
function fetchBoardJobs_(company) {
  const get = url => {
    try {
      const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null;
    } catch (e) {
      return null;
    }
  };
  for (const slug of boardSlugs(company)) {
    const gh = get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (gh && gh.jobs) return gh.jobs.map(j => ({ title: j.title, url: j.absolute_url }));
    const lever = get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (Array.isArray(lever)) return lever.map(j => ({ title: j.text, url: j.hostedUrl }));
    const ashby = get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (ashby && ashby.jobs) return ashby.jobs.map(j => ({ title: j.title, url: j.jobUrl }));
  }
  return [];
}

/** First result from Google Programmable Search, if it's configured. */
function searchPosting_(company, role) {
  if (!CONFIG.SEARCH_API_KEY || !CONFIG.SEARCH_ENGINE_ID) return '';
  const q = `"${company}" "${role}"`;
  try {
    const r = UrlFetchApp.fetch('https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(CONFIG.SEARCH_API_KEY) +
      '&cx=' + encodeURIComponent(CONFIG.SEARCH_ENGINE_ID) + '&num=1&q=' + encodeURIComponent(q), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return '';
    const items = JSON.parse(r.getContentText()).items || [];
    return items.length ? items[0].link : '';
  } catch (e) {
    return '';
  }
}

/** The posting's real URL, or '' to keep the search link. */
function findPostingLink_(company, role, boards) {
  if (!role) return '';
  const key = normCompany(company);
  if (!(key in boards)) boards[key] = fetchBoardJobs_(company);
  return bestJobMatch(boards[key], role) || searchPosting_(company, role);
}

// ---------- Matching emails to rows (pure) ----------

function normCompany(s) {
  return (s || '').toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|group|holdings|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normRole(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameCompany_(a, b) {
  const x = normCompany(a), y = normCompany(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}

/** A bare-year term ("2027") is compatible with any season in that year. */
function sameTerm_(a, b) {
  if (!a || !b || a === b) return true;
  const year = s => (String(s).match(/(20[2-3]\d)$/) || [])[1];
  return (/^20[2-3]\d$/.test(a) || /^20[2-3]\d$/.test(b)) && year(a) === year(b);
}

function sameRole_(a, b) {
  const x = normRole(a), y = normRole(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function canUpgrade(current, next) {
  if (!current) return true;
  if (!(current in STATUS_RANK)) return false; // hand-typed status: leave it alone
  return STATUS_RANK[next] > STATUS_RANK[current];
}

/**
 * table: {rows: [{values: {Header: value}, term, dirty: Set<header>, isNew: bool}]}
 * A row's term is its tab name, or '' for the No Term tab.
 * Mutates the table in place.
 */
function applyToTable_(table, p) {
  const row = findRow_(table.rows, p);
  if (!row) {
    table.rows.push({
      isNew: true,
      term: p.term || '',
      dirty: new Set(),
      values: {
        'Company': p.company || '?',
        'Role': p.role,
        'Status': p.status,
        'Date Applied': p.status === 'Applied' ? p.date : '',
        'Last Update': p.date,
        'Posting Link': p.link,
        'Source': p.source,
        'Email': p.threadUrl || '',
        'Notes': [p.notes, p.status !== 'Applied' && 'No confirmation email found'].filter(Boolean).join('; '),
      },
    });
    return;
  }
  const v = row.values;
  const set = (h, val) => { if (val !== '' && val != null && v[h] !== val) { v[h] = val; row.dirty.add(h); } };
  if (!v['Role'] && p.role) set('Role', p.role);
  if (p.status === 'Applied' && !v['Date Applied']) set('Date Applied', p.date);
  if (canUpgrade(v['Status'], p.status)) {
    set('Status', p.status);
    set('Last Update', p.date);
    set('Email', p.threadUrl);
  }
  if ((!v['Posting Link'] || /google\.com\/search/.test(v['Posting Link'])) && p.link && !/google\.com\/search/.test(p.link)) {
    set('Posting Link', p.link);
  }
}

function findRow_(rows, p) {
  if (!p.company) return null;
  // Summer 2026 and Summer 2027 at the same company are separate applications.
  const sameCo = rows.filter(r =>
    sameCompany_(r.values['Company'], p.company) && sameTerm_(r.term, p.term));
  if (!sameCo.length) return null;

  if (p.role) {
    const exact = sameCo.find(r => sameRole_(r.values['Role'], p.role));
    if (exact) return exact;
  }

  const recent = r => {
    const d = r.values['Last Update'] || r.values['Date Applied'];
    return d instanceof Date ? d.getTime() : 0;
  };
  const byRecent = sameCo.slice().sort((a, b) => recent(b) - recent(a));

  if (p.status === 'Applied') {
    // A second confirmation for the same company is only a duplicate if one of
    // them has no role and they arrived close together.
    const windowMs = CONFIG.MERGE_WINDOW_DAYS * 864e5;
    return byRecent.find(r =>
      (!p.role || !r.values['Role']) &&
      Math.abs(recent(r) - (p.date instanceof Date ? p.date.getTime() : 0)) <= windowMs) || null;
  }

  // Status update without a clear role match: the most recent open application at that company.
  if (p.role) {
    const roleless = byRecent.find(r => !r.values['Role']);
    if (roleless) return roleless;
  }
  return byRecent.find(r => canUpgrade(r.values['Status'], p.status)) || null;
}

// ---------- Sheet I/O ----------

function ensureSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name, tabPosition_(ss, name));
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);

  const col = h => HEADERS.indexOf(h) + 1;
  const statusRange = sheet.getRange(2, col('Status'), sheet.getMaxRows() - 1, 1);
  statusRange.setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES.concat(['Withdrawn', 'Ghosted']), true).setAllowInvalid(true).build());
  sheet.setConditionalFormatRules(Object.keys(STATUS_COLORS).map(s =>
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s).setBackground(STATUS_COLORS[s]).setRanges([statusRange]).build()));
  ['Date Applied', 'Last Update'].forEach(h => sheet.getRange(2, col(h), sheet.getMaxRows() - 1, 1).setNumberFormat('mmm d, yyyy'));
  sheet.setColumnWidth(col('Company'), 160);
  sheet.setColumnWidth(col('Role'), 260);
  sheet.setColumnWidth(col('Posting Link'), 220);
  sheet.setColumnWidth(col('Notes'), 260);
  return sheet;
}

// Keeps tracker tabs ordered newest term first, with "No Term" after them.
function tabPosition_(ss, name) {
  const key = termSortKey(name);
  const trackers = ss.getSheets().filter(isTrackerSheet_);
  const after = trackers.find(t => termSortKey(t.getName()) < key);
  if (after) return after.getIndex() - 1;
  return trackers.length ? trackers[trackers.length - 1].getIndex() : 0;
}

function headerOf_(sheet) {
  if (sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function isTrackerSheet_(sheet) {
  const header = headerOf_(sheet);
  return header.includes('Company') && header.includes('Status');
}

// Reads every tracker tab so status updates can find their row whichever tab it's on.
function readTables_(ss) {
  const rows = [];
  ss.getSheets().filter(isTrackerSheet_).forEach(sheet => {
    const header = headerOf_(sheet);
    const term = isTermName_(sheet.getName()) ? sheet.getName() : '';
    const lastRow = sheet.getLastRow();
    const data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, header.length).getValues() : [];
    data.forEach((r, i) => {
      const values = {};
      header.forEach((h, j) => { values[h] = r[j]; });
      rows.push({ sheet, header, rowNumber: i + 2, term, values, dirty: new Set(), isNew: false });
    });
  });
  return { rows };
}

function writeTables_(ss, table) {
  // Existing rows: only touch the cells that changed, so your edits and extra columns survive.
  table.rows.filter(r => !r.isNew && r.dirty.size).forEach(r => {
    r.dirty.forEach(h => {
      const c = r.header.indexOf(h) + 1;
      if (c > 0) r.sheet.getRange(r.rowNumber, c).setValue(r.values[h]);
    });
  });

  const byTab = {};
  table.rows.filter(r => r.isNew).forEach(r => {
    const tab = r.term || CONFIG.NO_TERM_SHEET_NAME;
    (byTab[tab] = byTab[tab] || []).push(r);
  });
  Object.keys(byTab).forEach(tab => {
    const sheet = ensureSheet_(ss, tab);
    const header = headerOf_(sheet);
    const out = byTab[tab].map(r => header.map(h => (h in r.values ? r.values[h] : '')));
    sheet.getRange(sheet.getLastRow() + 1, 1, out.length, header.length).setValues(out);
  });
}

// ---------- Skipped-email log ----------

/**
 * Emails that look application-related but produced no row: the place to look
 * when an application is missing. Plain search noise (a newsletter that said
 * "unfortunately") isn't logged, or the real misses would be buried.
 */
function worthReviewing_(from, subject) {
  const domain = senderDomain_(from || '');
  if (domain && isRecruitingDomain_(domain)) return true;
  const s = (subject || '').toLowerCase();
  return SUBJECT_PHRASES.some(p => new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b').test(s));
}

function saveSkipped_(ss, rows) {
  if (!rows.length) return;
  let sheet = ss.getSheetByName(CONFIG.SKIPPED_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SKIPPED_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['Date', 'From', 'Subject']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  const extra = sheet.getLastRow() - 1 - CONFIG.MAX_SKIPPED;
  if (extra > 0) sheet.deleteRows(2, extra);
}

function showSkipped() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SKIPPED_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Nothing skipped yet. Emails that look application-related but couldn\'t be read show up here after a scan.');
    return;
  }
  sheet.showSheet();
  ss.setActiveSheet(sheet);
}

function loadSeen_(ss) {
  const sheet = ss.getSheetByName(CONFIG.SEEN_SHEET_NAME);
  if (!sheet || sheet.getLastRow() === 0) return new Set();
  return new Set(sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => r[0]));
}

function saveSeen_(ss, ids) {
  if (!ids.length) return;
  let sheet = ss.getSheetByName(CONFIG.SEEN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SEEN_SHEET_NAME);
    sheet.hideSheet();
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, ids.length, 1).setValues(ids.map(id => [id]));
}
