import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { adminGetResume, adminDeleteResume } from '../../utils/api';

export default function AdminResumeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [resume, setResume] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminGetResume(id)
      .then(r => setResume(r.data))
      .catch(() => navigate('/admin/resumes'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!confirm('Delete this resume? Users will lose it from the extension picker.')) return;
    await adminDeleteResume(id);
    navigate('/admin/resumes');
  };

  if (loading) return <div className="admin-page"><div className="loading-inline"><div className="spinner" /></div></div>;
  if (!resume) return null;

  const owner = resume.userId;

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <div className="breadcrumb"><Link to="/admin/resumes">All resumes</Link> › Detail</div>
          <h1 className="page-title">{resume.title}</h1>
          <p className="page-sub">{resume.name || 'No candidate name'}</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={handleDelete}>Delete</button>
      </div>

      <div className="detail-meta-grid">
        <div className="meta-chip">
          <span className="meta-label">Owner</span>
          <span className="meta-value">{owner?.name || '—'}</span>
          {owner?.email && <span className="meta-value" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{owner.email}</span>}
        </div>
        <div className="meta-chip">
          <span className="meta-label">Contact</span>
          <span className="meta-value">{resume.email || '—'}</span>
          <span className="meta-value">{resume.phone || ''}</span>
        </div>
      </div>

      <div className="card">
        <h3 className="section-title">Structured data</h3>
        <pre className="json-preview">{JSON.stringify({
          name: resume.name,
          email: resume.email,
          phone: resume.phone,
          personal_info: resume.personal_info,
          experience: resume.experience,
          education: resume.education,
          skillset: resume.skillset
        }, null, 2)}</pre>
      </div>
    </div>
  );
}
