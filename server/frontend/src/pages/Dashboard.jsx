import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import ResumePdfUploadButton from '../components/ResumePdfUploadButton';
import { useAuth } from '../context/AuthContext';
import { getInterviewStats, getResumes, getInterviews } from '../utils/api';

function StatCard({ label, value, sub, to }) {
  const content = (
    <div className="stat-card">
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{content}</Link> : content;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats]   = useState(null);
  const [resumes, setResumes] = useState([]);
  const [recent, setRecent]   = useState([]);

  useEffect(() => {
    Promise.all([getInterviewStats(), getResumes(), getInterviews(1)])
      .then(([s, r, i]) => {
        setStats(s.data);
        setResumes(r.data.slice(0, 3));
        setRecent(i.data.sessions?.slice(0, 5) || []);
      })
      .catch(console.error);
  }, []);

  const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Welcome back, {user?.name} 👋</h2>
          <p className="page-sub">Here's what's happening with your interviews.</p>
        </div>
        <div className="page-header-actions">
          <ResumePdfUploadButton className="btn btn-primary">
            Upload resume (PDF)
          </ResumePdfUploadButton>
          <Link to="/resumes/new" className="btn btn-secondary">+ New resume (manual)</Link>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <StatCard label="Total Interviews" value={stats?.total} to="/interviews" />
        <StatCard label="Resumes" value={resumes.length} to="/resumes" />
        <StatCard
          label="Last Interview"
          value={fmtDate(stats?.lastSession?.startedAt)}
          sub={stats?.lastSession?.title}
        />
      </div>

      <div className="two-col">
        {/* Recent interviews */}
        <section className="card">
          <div className="card-header">
            <h3>Recent Interviews</h3>
            <Link to="/interviews" className="link-sm">View all →</Link>
          </div>
          {recent.length === 0
            ? <p className="empty-hint">No interviews yet. Install the extension and start one!</p>
            : <ul className="item-list">
                {recent.map(s => (
                  <li key={s._id}>
                    <Link to={`/interviews/${s._id}`} className="item-row">
                      <div className="item-main">
                        <span className="item-title">{s.title || 'Untitled Interview'}</span>
                        <span className="item-sub">{fmtDate(s.startedAt)}</span>
                      </div>
                      <span className="chevron">›</span>
                    </Link>
                  </li>
                ))}
              </ul>
          }
        </section>

        {/* Resumes */}
        <section className="card">
          <div className="card-header">
            <h3>Your Resumes</h3>
            <Link to="/resumes" className="link-sm">Manage →</Link>
          </div>
          {resumes.length === 0
            ? <p className="empty-hint">No resumes yet. <Link to="/resumes/new">Add one →</Link></p>
            : <ul className="item-list">
                {resumes.map(r => (
                  <li key={r._id}>
                    <Link to={`/resumes/${r._id}/edit`} className="item-row">
                      <div className="item-main">
                        <span className="item-title">{r.title}</span>
                        <span className="item-sub">{r.name || ''}</span>
                      </div>
                      <span className="chevron">›</span>
                    </Link>
                  </li>
                ))}
              </ul>
          }
        </section>
      </div>
    </div>
  );
}
