import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { adminGetInterview, adminDeleteInterview } from '../../utils/api';

export default function AdminInterviewDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all');

  useEffect(() => {
    adminGetInterview(id)
      .then(r => setSession(r.data))
      .catch(() => navigate('/admin/interviews'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!confirm('Delete this interview permanently?')) return;
    await adminDeleteInterview(id);
    navigate('/admin/interviews');
  };

  const fmtTime = ts => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDate = d => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) : '—');

  const getLines = () => {
    if (!session?.transcripts) return [];
    const { transcripts } = session;
    if (activeTab === 'all') {
      if (transcripts.all?.length) return transcripts.all;
      return [
        ...transcripts.interviewer.map(t => ({ ...t, speaker: 'interviewer' })),
        ...transcripts.user.map(t => ({ ...t, speaker: 'user' }))
      ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }
    return (transcripts[activeTab] || []).map(t => ({ ...t, speaker: activeTab }));
  };

  if (loading) return <div className="admin-page"><div className="loading-inline"><div className="spinner" /></div></div>;
  if (!session) return null;

  const lines = getLines();

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <div className="breadcrumb"><Link to="/admin/interviews">All interviews</Link> › Detail</div>
          <h1 className="page-title">{session.title || 'Interview'}</h1>
          <p className="page-sub">{fmtDate(session.startedAt)}</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={handleDelete}>Delete</button>
      </div>

      <div className="detail-meta-grid">
        <div className="meta-chip">
          <span className="meta-label">Owner</span>
          <span className="meta-value">{session.userId?.name || '—'}</span>
          {session.userId?.email && <span className="meta-value" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{session.userId.email}</span>}
        </div>
        {session.resumeId && (
          <div className="meta-chip">
            <span className="meta-label">Resume</span>
            <Link to={`/admin/resumes/${session.resumeId._id}`} className="meta-value link">{session.resumeId.title}</Link>
          </div>
        )}
        {session.jobDescription && (
          <div className="meta-chip wide">
            <span className="meta-label">Job description</span>
            <p className="meta-value jd-preview">{session.jobDescription.slice(0, 400)}{session.jobDescription.length > 400 ? '…' : ''}</p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Transcript</h3>
          <div className="tab-group">
            {['all', 'interviewer', 'user'].map(t => (
              <button key={t} type="button" className={`tab-btn${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {lines.length === 0 ? (
          <p className="empty-hint">No lines in this view.</p>
        ) : (
          <div className="transcript-list">
            {lines.map((line, i) => {
              const spk = line.speaker || 'interviewer';
              return (
                <div key={i} className={`transcript-line ${spk}`}>
                  <div className="line-meta">
                    <span className={`speaker-badge ${spk}`}>{spk === 'interviewer' ? '🎙 Interviewer' : '👤 You'}</span>
                    <span className="line-time">{fmtTime(line.timestamp)}</span>
                  </div>
                  <p className="line-text">{line.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
