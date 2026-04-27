import { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { getResume, createResume, updateResume } from '../utils/api';
import ResumePdfUploadButton from '../components/ResumePdfUploadButton';

const emptyExp  = () => ({ position: '', company: '', duration: '', description: '' });
const emptyEdu  = () => ({ degree: '', institution: '', year: '' });
const emptySkill = () => ({ category: '', skills: [''] });

function mergeParsed(prev, data) {
  const exp =
    data.experience?.length > 0
      ? data.experience.map(e => ({
          position: e.position || '',
          company: e.company || '',
          duration: e.duration || '',
          description: e.description || ''
        }))
      : prev.experience;
  const edu =
    data.education?.length > 0
      ? data.education.map(e => ({
          degree: e.degree || '',
          institution: e.institution || '',
          year: e.year || ''
        }))
      : prev.education;
  const hasSkills =
    data.skillset?.length > 0 &&
    (data.skillset.some(s => (s.category || '').trim()) ||
      data.skillset.some(s => Array.isArray(s.skills) && s.skills.some(t => String(t).trim())));
  const sk = hasSkills
    ? data.skillset.map(s => ({
        category: s.category || '',
        skills: Array.isArray(s.skills) && s.skills.length ? s.skills.map(String) : ['']
      }))
    : prev.skillset;

  return {
    ...prev,
    title: (data.title || '').trim() || prev.title,
    name: data.name || prev.name,
    email: data.email || prev.email,
    phone: data.phone || prev.phone,
    personal_info: {
      location: data.personal_info?.location ?? prev.personal_info?.location ?? ''
    },
    experience: exp,
    education: edu,
    skillset: sk,
    rawText: typeof data.rawText === 'string' ? data.rawText : prev.rawText
  };
}

export default function ResumeForm() {
  const { id } = useParams();
  const isEdit  = Boolean(id);
  const navigate = useNavigate();
  const location = useLocation();

  const [saving, setSaving]   = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError]     = useState('');

  // Pre-fill from PDF parse result passed via navigation state
  const navParsed = location.state?.parsedData;
  const [pdfNotice, setPdfNotice] = useState(!!navParsed);

  const [form, setForm] = useState(() => {
    if (navParsed) {
      return {
        title: navParsed.title || '',
        name: navParsed.name || '',
        email: navParsed.email || '',
        phone: navParsed.phone || '',
        personal_info: navParsed.personal_info || { location: '' },
        experience: navParsed.experience?.length ? navParsed.experience : [emptyExp()],
        education:  navParsed.education?.length  ? navParsed.education  : [emptyEdu()],
        skillset:   navParsed.skillset?.length
          ? navParsed.skillset.map(s => ({ ...s, skills: Array.isArray(s.skills) ? s.skills : [String(s.skills)] }))
          : [emptySkill()],
        rawText: navParsed.rawText || ''
      };
    }
    return {
      title: '', name: '', email: '', phone: '',
      personal_info: { location: '' },
      experience: [emptyExp()],
      education:  [emptyEdu()],
      skillset:   [emptySkill()],
      rawText: ''
    };
  });

  useEffect(() => {
    if (!isEdit) return;
    getResume(id)
      .then(r => {
        const d = r.data;
        setForm({
          title: d.title || '',
          name: d.name || '',
          email: d.email || '',
          phone: d.phone || '',
          personal_info: d.personal_info || { location: '' },
          experience: d.experience?.length ? d.experience : [emptyExp()],
          education:  d.education?.length  ? d.education  : [emptyEdu()],
          skillset:   d.skillset?.length   ? d.skillset.map(s => ({ ...s, skills: Array.isArray(s.skills) ? s.skills : [s.skills] })) : [emptySkill()],
          rawText: d.rawText || ''
        });
      })
      .catch(() => setError('Failed to load resume'))
      .finally(() => setLoading(false));
  }, [id]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const setNested = (key, subKey, val) => setForm(f => ({ ...f, [key]: { ...f[key], [subKey]: val } }));

  // Arrays
  const addItem = (key, empty) => set(key, [...form[key], empty()]);
  const removeItem = (key, i) => set(key, form[key].filter((_, idx) => idx !== i));
  const updateItem = (key, i, field, val) => {
    const arr = [...form[key]];
    arr[i] = { ...arr[i], [field]: val };
    set(key, arr);
  };

  // Skill tags (comma or enter separated inside each skillset row)
  const updateSkillList = (i, raw) => {
    const arr = [...form.skillset];
    arr[i] = { ...arr[i], skills: raw.split(',').map(s => s.trim()).filter(Boolean) };
    set('skillset', arr);
  };

  const submit = async e => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const { rawText, ...rest } = form;
      const payload = { ...rest, ...(rawText ? { rawText } : {}) };
      if (isEdit) await updateResume(id, payload);
      else await createResume(payload);
      navigate('/resumes');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save resume');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-inline"><div className="spinner" /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">{isEdit ? 'Edit Resume' : 'New Resume'}</h2>
          <p className="page-sub">
            {isEdit
              ? 'Replace from PDF anytime — opens File Explorer to pick a .pdf file.'
              : 'Upload a PDF (File Explorer) to autofill with AI, or fill the form manually.'}
          </p>
        </div>
        <div className="page-header-actions">
          <ResumePdfUploadButton
            className={isEdit ? 'btn btn-secondary' : 'btn btn-primary'}
            onParsed={data => {
              setForm(f => mergeParsed(f, data));
              setPdfNotice(true);
              setError('');
            }}
            onError={msg => setError(msg)}
            disabled={saving}
          >
            {isEdit ? 'Replace from PDF…' : 'Upload resume (PDF)'}
          </ResumePdfUploadButton>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/resumes')}>
            ← Back to list
          </button>
        </div>
      </div>

      <form onSubmit={submit} className="form-layout">
        {/* PDF import banner */}
        {pdfNotice && (
          <div style={{
            background: 'linear-gradient(135deg,#1a2e1a,#142814)',
            border: '1px solid #22c55e55',
            borderRadius: 'var(--radius)',
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12
          }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>✅</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: '#86efac', marginBottom: 4 }}>
                Resume autofilled from PDF
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Review every field below before saving — AI extraction is very good but not perfect.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPdfNotice(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, flexShrink: 0 }}
            >×</button>
          </div>
        )}

        <section className="card">
          <h3 className="section-title">PDF import</h3>
          <p className="page-sub" style={{ marginBottom: 14, lineHeight: 1.55 }}>
            Use the <strong>Upload resume (PDF)</strong> button above — it opens Windows File Explorer so you can
            select your résumé. Parsed fields appear in this form; review then save.
          </p>
          <ResumePdfUploadButton
            className="btn btn-secondary"
            fullWidth
            onParsed={data => {
              setForm(f => mergeParsed(f, data));
              setPdfNotice(true);
              setError('');
            }}
            onError={msg => setError(msg)}
            disabled={saving}
          >
            {pdfNotice ? 'Choose another PDF…' : 'Upload resume (PDF) again'}
          </ResumePdfUploadButton>
        </section>

        {/* Basic info */}
        <section className="card">
          <h3 className="section-title">Basic Information</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Resume Title <span className="required">*</span></label>
              <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Senior Developer Resume" required />
            </div>
            <div className="form-group">
              <label>Full Name</label>
              <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="John Doe" />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="john@example.com" />
            </div>
            <div className="form-group">
              <label>Phone</label>
              <input value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+1 555 000 0000" />
            </div>
            <div className="form-group">
              <label>Location</label>
              <input value={form.personal_info.location} onChange={e => setNested('personal_info', 'location', e.target.value)} placeholder="City, Country" />
            </div>
          </div>
        </section>

        {/* Experience */}
        <section className="card">
          <div className="section-header">
            <h3 className="section-title">Experience</h3>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => addItem('experience', emptyExp)}>+ Add</button>
          </div>
          {form.experience.map((exp, i) => (
            <div key={i} className="array-item">
              <div className="array-item-header">
                <span className="array-index">#{i + 1}</span>
                {form.experience.length > 1 && (
                  <button type="button" className="btn-icon danger" onClick={() => removeItem('experience', i)}>✕</button>
                )}
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label>Position</label>
                  <input value={exp.position} onChange={e => updateItem('experience', i, 'position', e.target.value)} placeholder="Software Engineer" />
                </div>
                <div className="form-group">
                  <label>Company</label>
                  <input value={exp.company} onChange={e => updateItem('experience', i, 'company', e.target.value)} placeholder="Acme Corp" />
                </div>
                <div className="form-group">
                  <label>Duration</label>
                  <input value={exp.duration} onChange={e => updateItem('experience', i, 'duration', e.target.value)} placeholder="Jan 2022 – Present" />
                </div>
                <div className="form-group span-2">
                  <label>Description</label>
                  <textarea rows={2} value={exp.description} onChange={e => updateItem('experience', i, 'description', e.target.value)} placeholder="What you did here…" />
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* Education */}
        <section className="card">
          <div className="section-header">
            <h3 className="section-title">Education</h3>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => addItem('education', emptyEdu)}>+ Add</button>
          </div>
          {form.education.map((edu, i) => (
            <div key={i} className="array-item">
              <div className="array-item-header">
                <span className="array-index">#{i + 1}</span>
                {form.education.length > 1 && (
                  <button type="button" className="btn-icon danger" onClick={() => removeItem('education', i)}>✕</button>
                )}
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label>Degree</label>
                  <input value={edu.degree} onChange={e => updateItem('education', i, 'degree', e.target.value)} placeholder="B.Sc. Computer Science" />
                </div>
                <div className="form-group">
                  <label>Institution</label>
                  <input value={edu.institution} onChange={e => updateItem('education', i, 'institution', e.target.value)} placeholder="MIT" />
                </div>
                <div className="form-group">
                  <label>Year</label>
                  <input value={edu.year} onChange={e => updateItem('education', i, 'year', e.target.value)} placeholder="2020" />
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* Skillset */}
        <section className="card">
          <div className="section-header">
            <h3 className="section-title">Skills</h3>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => addItem('skillset', emptySkill)}>+ Add Category</button>
          </div>
          {form.skillset.map((s, i) => (
            <div key={i} className="array-item">
              <div className="array-item-header">
                <span className="array-index">#{i + 1}</span>
                {form.skillset.length > 1 && (
                  <button type="button" className="btn-icon danger" onClick={() => removeItem('skillset', i)}>✕</button>
                )}
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label>Category</label>
                  <input value={s.category} onChange={e => updateItem('skillset', i, 'category', e.target.value)} placeholder="Frontend" />
                </div>
                <div className="form-group span-2">
                  <label>Skills <span className="optional">(comma-separated)</span></label>
                  <input value={s.skills.join(', ')} onChange={e => updateSkillList(i, e.target.value)} placeholder="React, TypeScript, CSS" />
                </div>
              </div>
            </div>
          ))}
        </section>

        {error && <div className="error-banner">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/resumes')}>← Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Resume'}
          </button>
        </div>
      </form>
    </div>
  );
}
