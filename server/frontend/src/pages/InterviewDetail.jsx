import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getInterview, deleteInterview } from '../utils/api';

export default function InterviewDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all');  // 'all' | 'interviewer' | 'user'

  useEffect(() => {
    getInterview(id)
      .then(r => setSession(r.data))
      .catch(() => navigate('/interviews'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!confirm('Delete this interview session?')) return;
    await deleteInterview(id);
    navigate('/interviews');
  };

  const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  const fmtDate = d => d ? new Date(d).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) : '—';

  const getLines = () => {
    const { transcripts } = session;
    if (activeTab === 'all') {
      // Use all array if available, otherwise merge interviewer + user sorted by timestamp
      if (transcripts.all?.length) return transcripts.all;
      return [
        ...transcripts.interviewer.map(t => ({ ...t, speaker: 'interviewer' })),
        ...transcripts.user.map(t => ({ ...t, speaker: 'user' }))
      ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }
    return (transcripts[activeTab] || []).map(t => ({ ...t, speaker: activeTab }));
  };

  if (loading) return <div className="loading-inline"><div className="spinner" /></div>;
  if (!session) return null;

  const lines = getLines();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb"><Link to="/interviews">Interviews</Link> › {session.title || 'Interview'}</div>
          <h2 className="page-title">{session.title || 'Interview'}</h2>
          <p className="page-sub">{fmtDate(session.startedAt)}</p>
        </div>
        <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
      </div>

      {/* Meta */}
      <div className="detail-meta-grid">
        {session.resumeId && (
          <div className="meta-chip">
            <span className="meta-label">Resume</span>
            <Link to={`/resumes/${session.resumeId._id}/edit`} className="meta-value link">
              {session.resumeId.title}
            </Link>
          </div>
        )}
        {session.jobDescription && (
          <div className="meta-chip wide">
            <span className="meta-label">Job Description</span>
            <p className="meta-value jd-preview">{session.jobDescription.slice(0, 300)}{session.jobDescription.length > 300 ? '…' : ''}</p>
          </div>
        )}
        {session.additionalInfo && (
          <div className="meta-chip wide">
            <span className="meta-label">Additional Info</span>
            <p className="meta-value">{session.additionalInfo}</p>
          </div>
        )}
      </div>

      {/* Transcript */}
      <div className="card">
        <div className="card-header">
          <h3>Transcript</h3>
          <div className="tab-group">
            {['all', 'interviewer', 'user'].map(t => (
              <button key={t} className={`tab-btn${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {lines.length === 0 ? (
          <p className="empty-hint">No transcript lines for this view.</p>
        ) : (
          <div className="transcript-list">
            {lines.map((line, i) => {
              const spk = line.speaker || 'interviewer';
              return (
                <div key={i} className={`transcript-line ${spk}`}>
                  <div className="line-meta">
                    <span className={`speaker-badge ${spk}`}>
                      {spk === 'interviewer' ? '🎙 Interviewer' : '👤 You'}
                    </span>
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
