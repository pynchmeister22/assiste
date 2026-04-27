import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getResumes, deleteResume } from '../utils/api';
import ResumePdfUploadButton from '../components/ResumePdfUploadButton';

export default function Resumes() {
  const [resumes, setResumes]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [deleting, setDeleting] = useState(null);
  const [uploadError, setUploadError] = useState('');

  const load = () => {
    setLoading(true);
    getResumes()
      .then(r => setResumes(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleDelete = async (id, title) => {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      await deleteResume(id);
      setResumes(prev => prev.filter(r => r._id !== id));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete resume');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Resumes</h2>
          <p className="page-sub">Stored as JSON on the server — available to the extension during interviews.</p>
        </div>
        <div className="page-header-actions">
          <ResumePdfUploadButton
            className="btn btn-primary"
            onError={msg => setUploadError(msg)}
          >
            Upload resume (PDF)
          </ResumePdfUploadButton>
          <Link to="/resumes/new" className="btn btn-secondary">+ Add manually</Link>
        </div>
      </div>

      {uploadError && (
        <div className="error-banner" style={{ marginBottom: 20 }}>
          {uploadError}
          <button
            type="button"
            onClick={() => setUploadError('')}
            style={{ marginLeft: 12, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }}
          >×</button>
        </div>
      )}

      {loading ? (
        <div className="loading-inline"><div className="spinner" /></div>
      ) : resumes.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📄</div>
          <h3>No resumes yet</h3>
          <p style={{ marginBottom: 20 }}>Upload a PDF (opens File Explorer) or add fields manually.</p>
          <div className="page-header-actions" style={{ justifyContent: 'center', maxWidth: 360, margin: '0 auto' }}>
            <ResumePdfUploadButton
              className="btn btn-primary"
              fullWidth
              onError={msg => setUploadError(msg)}
            >
              Upload resume (PDF)
            </ResumePdfUploadButton>
            <Link to="/resumes/new" className="btn btn-secondary" style={{ textAlign: 'center' }}>+ Add manually</Link>
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {resumes.map(r => (
            <div key={r._id} className="resume-card">
              <div className="resume-card-header">
                <div className="resume-avatar">
                  {((r.name || r.title || '?')[0]).toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="resume-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </div>
                  <div className="resume-name">{r.name || '—'}</div>
                </div>
              </div>

              <div className="resume-meta">
                {(r.email || r.phone) && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {r.email && <span title="Email">✉ {r.email}</span>}
                    {r.phone && <span title="Phone">📞 {r.phone}</span>}
                  </div>
                )}

                {r.personal_info?.location && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    📍 {r.personal_info.location}
                  </div>
                )}

                {r.experience?.filter(e => e.position || e.company).length > 0 && (
                  <div className="resume-exp">
                    💼 {r.experience.filter(e => e.position || e.company).length} job
                    {r.experience.filter(e => e.position || e.company).length !== 1 ? 's' : ''}
                    {r.experience[0]?.position && (
                      <span style={{ color: 'var(--text)', marginLeft: 4 }}>
                        — {r.experience[0].position}
                        {r.experience[0].company ? ` @ ${r.experience[0].company}` : ''}
                      </span>
                    )}
                  </div>
                )}

                {r.education?.filter(e => e.degree || e.institution).length > 0 && (
                  <div className="resume-exp">
                    🎓 {r.education[0].degree}
                    {r.education[0].institution ? ` — ${r.education[0].institution}` : ''}
                    {r.education[0].year ? ` (${r.education[0].year})` : ''}
                  </div>
                )}

                {r.skillset?.filter(s => s.skills?.length).length > 0 && (
                  <div className="skill-tags">
                    {r.skillset.slice(0, 3).map((s, i) => (
                      <span key={i} className="tag" title={Array.isArray(s.skills) ? s.skills.join(', ') : ''}>
                        {s.category || 'Skills'}
                        {Array.isArray(s.skills) && s.skills.length > 0 && (
                          <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
                            ({s.skills.length})
                          </span>
                        )}
                      </span>
                    ))}
                    {r.skillset.length > 3 && (
                      <span className="tag muted">+{r.skillset.length - 3} more</span>
                    )}
                  </div>
                )}

                {r.updatedAt && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Updated {new Date(r.updatedAt).toLocaleDateString()}
                  </div>
                )}
              </div>

              <div className="resume-actions">
                <Link to={`/resumes/${r._id}/edit`} className="btn btn-sm btn-secondary">Edit</Link>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => handleDelete(r._id, r.title)}
                  disabled={deleting === r._id}
                >
                  {deleting === r._id ? '…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
