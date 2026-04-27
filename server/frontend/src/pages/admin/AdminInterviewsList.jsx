import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminGetInterviews, adminDeleteInterview } from '../../utils/api';

export default function AdminInterviewsList() {
  const [data, setData]     = useState({ sessions: [], total: 0, pages: 1 });
  const [page, setPage]     = useState(1);
  const [userFilter, setUserFilter] = useState('');
  const [appliedUserId, setAppliedUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  const load = (p = 1, userId = appliedUserId) => {
    setLoading(true);
    adminGetInterviews(p, userId.trim())
      .then(r => { setData(r.data); setPage(p); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(1, ''); }, []);

  const applyFilter = () => {
    setAppliedUserId(userFilter.trim());
    load(1, userFilter.trim());
  };

  const clearFilter = () => {
    setUserFilter('');
    setAppliedUserId('');
    load(1, '');
  };

  const handleDelete = async (id, title) => {
    if (!confirm(`Delete interview "${title}"?`)) return;
    setDeleting(id);
    try {
      await adminDeleteInterview(id);
      load(page, appliedUserId);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  const fmtDate = d => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">All interviews</h1>
          <p className="page-sub">{data.total} session{data.total !== 1 ? 's' : ''} across all users</p>
        </div>
      </div>

      <div className="card filter-bar" style={{ marginBottom: 16, padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <label style={{ margin: 0 }}>Owner user ID</label>
        <input style={{ maxWidth: 280 }} placeholder="MongoDB ObjectId" value={userFilter} onChange={e => setUserFilter(e.target.value)} />
        <button type="button" className="btn btn-primary btn-sm" onClick={applyFilter}>Apply</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilter}>Clear</button>
      </div>

      {loading ? (
        <div className="loading-inline"><div className="spinner" /></div>
      ) : data.sessions.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon">🎙</div>
          <h3>No interviews</h3>
          <p>No sessions match this filter.</p>
        </div>
      ) : (
        <>
          <div className="table-wrapper card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>User</th>
                  <th>Resume</th>
                  <th>Started</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map(s => (
                  <tr key={s._id}>
                    <td><Link to={`/admin/interviews/${s._id}`} className="table-link">{s.title || 'Untitled'}</Link></td>
                    <td>{s.userId?.name || '—'} <span className="mono-sub">{s.userId?._id ? `(${String(s.userId._id).slice(0, 8)}…)` : ''}</span></td>
                    <td>{s.resumeId?.title || '—'}</td>
                    <td>{fmtDate(s.startedAt)}</td>
                    <td className="table-actions">
                      <Link to={`/admin/interviews/${s._id}`} className="btn btn-sm btn-secondary">View</Link>
                      <button className="btn btn-sm btn-danger" disabled={deleting === s._id} onClick={() => handleDelete(s._id, s.title)}>
                        {deleting === s._id ? '…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="pagination">
              <button className="btn btn-sm btn-secondary" onClick={() => load(page - 1, appliedUserId)} disabled={page <= 1}>← Prev</button>
              <span className="page-info">Page {page} / {data.pages}</span>
              <button className="btn btn-sm btn-secondary" onClick={() => load(page + 1, appliedUserId)} disabled={page >= data.pages}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
