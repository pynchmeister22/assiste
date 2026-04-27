const OpenAI = require('openai');

/**
 * Detailed instructions so work history maps cleanly to position / company / duration / description.
 * PDF text is often scrambled (columns, headers); the model must infer one job per employer period.
 */
const SYSTEM_PROMPT = `You are an expert résumé / CV parser. The input is plain text extracted from a PDF (order may be broken, columns interleaved, or headers repeated). Infer structure carefully.

Return ONLY one valid JSON object (no markdown, no commentary) with exactly these keys:

{
  "title": "string",
  "name": "string",
  "email": "string",
  "phone": "string",
  "personal_info": { "location": "string" },
  "experience": [
    {
      "position": "string",
      "company": "string",
      "duration": "string",
      "description": "string"
    }
  ],
  "education": [
    { "degree": "string", "institution": "string", "year": "string" }
  ],
  "skillset": [
    { "category": "string", "skills": ["string", "..."] }
  ]
}

WORK EXPERIENCE — critical rules (follow exactly):
1. Create **one object per distinct job** (same employer + overlapping dates = usually one object; a promotion to a new title = new object if clearly separate).
2. **position** = job title ONLY (e.g. "Senior Software Engineer", "Product Manager"). No employer name, no dates, no city in this field.
3. **company** = employer name ONLY (legal or well-known trade name). Strip "Remote", city, country from company when they appear as suffixes (put city in description if needed, not company).
4. **duration** = the employment date range as written or normalized (e.g. "Jan 2020 – Present", "2018 – 2021", "Mar 2019 to Dec 2020"). If only one year, use that year.
5. **description** = ALL bullets, metrics, technologies, and responsibilities for THAT role only. Join bullet lines with newline characters \\n inside the string. Do NOT paste unrelated sections (education, skills) here.
6. If the PDF merged title + company on one line (e.g. "Software Engineer at Acme Inc", "Acme — Software Engineer", "Engineer | Acme"), **split** so position and company are correct — never leave the full combined line only in description while position/company are empty.
7. Do NOT output a single giant experience entry that contains the whole résumé. Split into multiple jobs whenever dates or employers change.
8. If a job has no bullets, still output position, company, duration; description may be "".

Education, skills, contact:
- Extract every degree/school row into education[].
- Group skills into sensible categories (Languages, Frameworks, Cloud, Data, Tools, etc.).
- title: prefer "Name – Primary Job Title" using the most recent or strongest role.
- Use "" for unknown strings; use [] only where the schema shows an array.

Remember: return ONLY the JSON object.`;

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Heuristic split when the model left "Title at Company" in one field.
 */
function splitTitleCompany(position, company) {
  let pos = trimStr(position);
  let comp = trimStr(company);
  if (comp && pos) return { position: pos, company: comp };

  const text = pos || comp;
  if (!text) return { position: pos, company: comp };

  const atMatch = text.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    return { position: atMatch[1].trim(), company: atMatch[2].trim() };
  }
  const atSym = text.match(/^(.+?)\s+@\s+(.+)$/);
  if (atSym) {
    return { position: atSym[1].trim(), company: atSym[2].trim() };
  }

  const pipe = text.split(/\s*\|\s*/);
  if (pipe.length >= 2 && !comp) {
    const a = pipe[0].trim();
    const b = pipe.slice(1).join(' | ').trim();
    const titleHint = /engineer|developer|manager|lead|analyst|architect|director|specialist|consultant|designer|scientist|intern|officer|head|vp|vice president/i;
    if (titleHint.test(a) && !titleHint.test(b)) return { position: a, company: b };
    if (titleHint.test(b) && !titleHint.test(a)) return { position: b, company: a };
    return { position: a, company: b };
  }

  const emDash = text.match(/^(.+?)\s*[–—-]\s*(.+)$/);
  if (emDash && !comp) {
    const a = emDash[1].trim();
    const b = emDash[2].trim();
    const titleHint = /engineer|developer|manager|lead|analyst|architect|director|specialist|consultant|designer|scientist/i;
    if (titleHint.test(b) && a.length > 2 && a.length < 80) return { position: b, company: a };
    if (titleHint.test(a) && b.length > 2 && b.length < 80) return { position: a, company: b };
  }

  const comma = text.match(/^([^,]{2,80}),\s*(.+)$/);
  if (comma && !comp) {
    const a = comma[1].trim();
    const b = comma[2].trim();
    const corp = /\b(inc|llc|ltd|corp|corporation|plc|gmbh|ag|sa|bv|pvt|limited)\b/i;
    if (corp.test(b)) return { position: a, company: b };
    if (corp.test(a)) return { position: b, company: a };
  }

  return { position: pos, company: comp };
}

/** Strip common trailing junk from company */
function cleanCompany(name) {
  let s = trimStr(name);
  s = s.replace(/\s*[([]\s*(remote|hybrid|onsite)\s*[)\]]/gi, '').trim();
  s = s.replace(/[,;]\s*(remote|hybrid)\s*$/i, '').trim();
  return s;
}

function normalizeExperienceEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(e => {
      let position = trimStr(e.position);
      let company = cleanCompany(trimStr(e.company));
      let duration = trimStr(e.duration);
      let description = trimStr(e.description);

      // Model sometimes puts "Title at Company" entirely in `company` or `description` first line
      if (!position && company) {
        const s = splitTitleCompany(company, '');
        position = s.position;
        company = s.company;
      }
      if (!company && position) {
        const s = splitTitleCompany(position, '');
        position = s.position;
        company = s.company;
      }
      const firstDescLine = description.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
      const looksLikeTitleLine =
        firstDescLine.length > 5 &&
        firstDescLine.length < 180 &&
        (/\bat\b/i.test(firstDescLine) || /\s@\s/.test(firstDescLine) || /\s\|\s/.test(firstDescLine) || /\s[–—]\s/.test(firstDescLine));
      if ((!position || !company) && looksLikeTitleLine) {
        const s = splitTitleCompany(firstDescLine, '');
        if (s.company && (!company || company === firstDescLine)) company = s.company;
        if (s.position && (!position || position === firstDescLine)) position = s.position;
        if (s.position && s.company && description.startsWith(firstDescLine)) {
          description = description.slice(firstDescLine.length).replace(/^\s*\n+/, '').trim();
        }
      }

      const split = splitTitleCompany(position, company);
      position = split.position;
      company = cleanCompany(split.company);

      if (!company && position) {
        const m = position.match(/^(.+?),\s*(.+)$/);
        if (m) {
          const a = m[1].trim();
          const b = m[2].trim();
          if (/\b(inc|llc|ltd|corp|corporation|plc|gmbh)\b/i.test(b)) {
            position = a;
            company = b;
          }
        }
      }

      if (position.length > 120) position = position.slice(0, 120);
      if (company.length > 120) company = company.slice(0, 120);
      if (duration.length > 120) duration = duration.slice(0, 120);
      if (description.length > 8000) description = description.slice(0, 8000);

      return { position, company, duration, description };
    })
    .filter(e => e.position || e.company || e.description.length > 20);
}

/**
 * @param {string} text  Raw text extracted from the PDF
 * @param {{ filename?: string, apiKey?: string }} opts
 */
async function parseResumeWithOpenAI(text, { filename = '', apiKey = '' } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured on the server');

  const client = new OpenAI({ apiKey: key });

  const truncated =
    text.length > 24000 ? text.slice(0, 24000) + '\n\n[… résumé text truncated for parsing …]' : text;

  const userContent = `The text below was extracted from a candidate's résumé PDF. Layout may be imperfect.

Parse it into the JSON schema from your system instructions. Pay special attention to splitting **each job** into its own experience object with correct **position**, **company**, **duration**, and **description**.

---BEGIN RÉSUMÉ TEXT---
${truncated}
---END RÉSUMÉ TEXT---`;

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.15,
    max_tokens: 8192
  });

  const raw = completion.choices[0]?.message?.content || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OpenAI returned malformed JSON — try again');
  }

  const sanitize = v => (typeof v === 'string' ? v.trim() : '');

  let experience = normalizeExperienceEntries(parsed.experience);

  const education = Array.isArray(parsed.education)
    ? parsed.education
        .map(e => ({
          degree: sanitize(e.degree),
          institution: sanitize(e.institution),
          year: sanitize(e.year)
        }))
        .filter(e => e.degree || e.institution)
    : [];

  const skillset = Array.isArray(parsed.skillset)
    ? parsed.skillset
        .map(s => ({
          category: sanitize(s.category),
          skills: Array.isArray(s.skills) ? s.skills.map(String).filter(Boolean) : []
        }))
        .filter(s => s.skills.length > 0)
    : [];

  const fallbackTitle = filename.replace(/\.pdf$/i, '').trim() || 'Imported Resume';

  if (!experience.length) {
    experience = [{ position: '', company: '', duration: '', description: '' }];
  }

  return {
    title: sanitize(parsed.title) || fallbackTitle,
    name: sanitize(parsed.name),
    email: sanitize(parsed.email),
    phone: sanitize(parsed.phone),
    personal_info: { location: sanitize(parsed.personal_info?.location) },
    experience,
    education: education.length ? education : [{ degree: '', institution: '', year: '' }],
    skillset: skillset.length ? skillset : [{ category: '', skills: [''] }],
    rawText: text.slice(0, 50000)
  };
}

module.exports = { parseResumeWithOpenAI };
