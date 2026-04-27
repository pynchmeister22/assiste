import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminGetStats } from '../../utils/api';

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminGetStats()
      .then(r => setStats(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const fmtDate = d => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—');

  if (loading) return <div className="admin-page"><div className="loading-inline"><div className="spinner" /></div></div>;

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Admin overview</h1>
          <p className="page-sub">System-wide metrics and recent activity.</p>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {stats && (
        <>
          <div className="stats-grid admin-stats">
            <div className="stat-card"><div className="stat-value">{stats.usersTotal}</div><div className="stat-label">Users</div></div>
            <div className="stat-card"><div className="stat-value">{stats.usersActive}</div><div className="stat-label">Active users</div></div>
            <div className="stat-card"><div className="stat-value">{stats.admins}</div><div className="stat-label">Admins</div></div>
            <div className="stat-card"><div className="stat-value">{stats.resumesTotal}</div><div className="stat-label">Resumes</div></div>
            <div className="stat-card"><div className="stat-value">{stats.interviewsTotal}</div><div className="stat-label">Interview sessions</div></div>
          </div>

          <div className="two-col">
            <section className="card">
              <div className="card-header">
                <h3>Newest users</h3>
                <Link to="/admin/users" className="link-sm">Manage →</Link>
              </div>
              <ul className="item-list">
                {(stats.recentUsers || []).map(u => (
                  <li key={u._id}>
                    <Link to="/admin/users" className="item-row">
                      <div className="item-main">
                        <span className="item-title">{u.name}</span>
                        <span className="item-sub">{u.isAdmin ? 'Admin' : 'User'} · {u.isActive ? 'active' : 'inactive'}</span>
                      </div>
                      <span className="chevron">›</span>
                    </Link>
                  </li>
                ))}
                {(!stats.recentUsers || stats.recentUsers.length === 0) && (
                  <p className="empty-hint">No users yet.</p>
                )}
              </ul>
            </section>

            <section className="card">
              <div className="card-header">
                <h3>Latest interviews</h3>
                <Link to="/admin/interviews" className="link-sm">View all →</Link>
              </div>
              <ul className="item-list">
                {(stats.recentInterviews || []).map(s => (
                  <li key={s._id}>
                    <Link to={`/admin/interviews/${s._id}`} className="item-row">
                      <div className="item-main">
                        <span className="item-title">{s.title || 'Untitled'}</span>
                        <span className="item-sub">{s.userId?.name || 'Unknown user'} · {fmtDate(s.startedAt)}</span>
                      </div>
                      <span className="chevron">›</span>
                    </Link>
                  </li>
                ))}
                {(!stats.recentInterviews || stats.recentInterviews.length === 0) && (
                  <p className="empty-hint">No interviews yet.</p>
                )}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
