/**
 * Best-effort resume fields from plain text (e.g. PDF extraction).
 * Real PDFs vary widely; this favors common Western resume patterns.
 */

function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : '';
}

function extractPhone(text) {
  const patterns = [
    /\+\d{1,3}[\s.-]?\d[\d\s().-]{8,14}/,
    /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
    /\d{3}[\s.-]\d{3}[\s.-]\d{4}/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function extractLocation(text) {
  const labeled = text.match(/(?:location|address|based in|residing)\s*[:\-]\s*([^\n]+)/i);
  if (labeled) return labeled[1].trim().slice(0, 120);
  const citySt = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?),\s*[A-Z]{2}\b/);
  if (citySt) return citySt[0];
  return '';
}

function guessName(lines, email) {
  const skip =
    /^(resume|cv|curriculum vitae|profile|phone|tel|mobile|email|e-mail|linkedin|github|www\.|http|objective|summary)\b/i;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    let line = lines[i].trim();
    if (!line || line.length < 2 || line.length > 85) continue;
    if (skip.test(line)) continue;
    if (line.includes('@')) continue;
    if (email && line.includes(email)) continue;
    if (/^\d[\d\s().+/-]{6,}$/.test(line.replace(/\s/g, ''))) continue;
    if (/^[•\-\*|◦▪]/.test(line)) continue;
    if (/^\d{4}\s*[-–]\s*/.test(line)) continue;
    if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+){1,3}$/.test(line)) return line;
    if (/^[A-Z][^.:]+$/.test(line) && !line.includes('|')) return line.slice(0, 80);
  }
  return '';
}

function sliceBetween(text, startRe, endRes) {
  const m = text.match(startRe);
  if (!m || m.index === undefined) return '';
  let pos = m.index + m[0].length;
  const nl = text.indexOf('\n', pos);
  if (nl >= 0) pos = nl + 1;
  let end = text.length;
  const rest = text.slice(pos);
  for (const endRe of endRes) {
    const idx = rest.search(endRe);
    if (idx >= 0) end = Math.min(end, pos + idx);
  }
  return text.slice(pos, end).trim();
}

function parseExperienceBlocks(sectionText) {
  if (!sectionText) return [];
  const blocks = sectionText.split(/\n\n+/).map(b => b.trim()).filter(b => b.length > 8);
  const out = [];
  for (const block of blocks.slice(0, 12)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let position = '';
    let company = '';
    let duration = '';
    let description = block;

    const head = lines[0];
    const atSplit = head.split(/\s+at\s+/i);
    if (atSplit.length === 2) {
      position = atSplit[0].replace(/^[-•\s]+/, '').trim();
      const rest = atSplit[1];
      const pipe = rest.split(/\s*[|–-]\s*/);
      company = (pipe[0] || '').trim();
      if (pipe[1]) duration = pipe.slice(1).join(' – ').trim();
    } else {
      const sep = head.split(/\s*[|]\s*/);
      if (sep.length >= 2) {
        position = sep[0].trim();
        company = sep[1].split(/\s+[–-]\s+/)[0].trim();
        const durPart = head.match(/\b(19|20)\d{2}\b.*$/);
        if (durPart) duration = durPart[0].trim();
      } else {
        const dash = head.match(/^(.+?)\s+[–-]\s+(.+)$/);
        if (dash) {
          position = dash[1].trim();
          company = dash[2].trim();
        } else {
          position = head.slice(0, 120);
        }
      }
    }

    const durLine = lines.find(
      l =>
        /\b(19|20)\d{2}\b/.test(l) &&
        (l.includes('–') || l.includes('-') || /\bto\b/i.test(l) || /present/i.test(l))
    );
    if (durLine && !duration) duration = durLine.trim().slice(0, 80);

    const bullets = lines
      .slice(1)
      .filter(l => /^[•\-\*◦▪\u2022]/.test(l) || l.length > 40)
      .join('\n');
    if (bullets) description = bullets;
    else if (lines.length > 1) description = lines.slice(1).join('\n');

    if (position || company) {
      out.push({
        position: position.slice(0, 200),
        company: company.slice(0, 200),
        duration: duration.slice(0, 120),
        description: description.slice(0, 4000)
      });
    }
  }
  return out.length ? out : [];
}

function parseEducationLines(sectionText) {
  if (!sectionText) return [];
  const degreeRe =
    /(Bachelor|B\.?S\.?|B\.?A\.?|Master|M\.?S\.?|M\.?A\.?|MBA|Ph\.?D\.?|Associate|Diploma|Certificate)\b/i;
  const lines = sectionText.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!degreeRe.test(line)) continue;
    let institution = '';
    let year = '';
    if (i + 1 < lines.length && lines[i + 1].length < 120) institution = lines[i + 1];
    const ym = line.match(/\b(19|20)\d{2}\b/g);
    if (ym) year = ym[ym.length - 1];
    out.push({
      degree: line.slice(0, 200),
      institution: (institution || '').slice(0, 200),
      year: year || ''
    });
  }
  return out.slice(0, 8);
}

function parseSkillsLine(sectionText) {
  if (!sectionText) return [];
  const lines = sectionText.split('\n').map(l => l.trim()).filter(Boolean);
  let best = '';
  for (const line of lines) {
    const commas = (line.match(/,/g) || []).length;
    if (commas >= 3 && line.length > commas * 2) best = line.length > best.length ? line : best;
  }
  if (!best && lines[0]) best = lines[0];
  const skills = best
    .split(/[,;|]/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length < 80)
    .slice(0, 60);
  if (!skills.length) return [];
  return [{ category: 'Imported', skills }];
}

/**
 * @param {string} rawText
 * @param {{ filename?: string }} [meta]
 */
function parseResumeText(rawText, meta = {}) {
  const text = normalizeText(rawText);
  if (!text) {
    return {
      title: '',
      name: '',
      email: '',
      phone: '',
      personal_info: { location: '' },
      experience: [],
      education: [],
      skillset: [],
      rawText: ''
    };
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const location = extractLocation(text);
  const name = guessName(lines, email);

  const expSection = sliceBetween(
    text,
    /\b(EXPERIENCE|WORK EXPERIENCE|EMPLOYMENT|PROFESSIONAL EXPERIENCE|CAREER HISTORY)\b/i,
    [/\b(EDUCATION|ACADEMIC|SKILLS|TECHNICAL SKILLS|PROJECTS|CERTIFICATION)\b/i]
  );
  let experience = parseExperienceBlocks(expSection || text.slice(0, Math.min(text.length, 8000)));

  const eduSection = sliceBetween(
    text,
    /\b(EDUCATION|ACADEMIC)\b/i,
    [/\b(EXPERIENCE|SKILLS|PROJECTS|CERTIFICATION|WORK)\b/i]
  );
  let education = parseEducationLines(eduSection);

  const skillSection = sliceBetween(
    text,
    /\b(SKILLS|TECHNICAL SKILLS|CORE COMPETENCIES|TECHNOLOGIES)\b/i,
    [/\b(EXPERIENCE|EDUCATION|PROJECTS|CERTIFICATION)\b/i]
  );
  let skillset = parseSkillsLine(skillSection);

  const baseTitle = (meta.filename || '').replace(/\.pdf$/i, '').trim() || 'Imported resume';

  if (!experience.length) {
    experience = [
      {
        position: '',
        company: '',
        duration: '',
        description: text.slice(0, 3500)
      }
    ];
  }
  if (!education.length) {
    education = [{ degree: '', institution: '', year: '' }];
  }
  if (!skillset.length) {
    skillset = [{ category: '', skills: [''] }];
  }

  return {
    title: baseTitle.slice(0, 200),
    name,
    email,
    phone,
    personal_info: { location },
    experience,
    education,
    skillset,
    rawText: text.slice(0, 50000)
  };
}

module.exports = { parseResumeText, normalizeText };
