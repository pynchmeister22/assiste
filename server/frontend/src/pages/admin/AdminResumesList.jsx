import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminGetResumes, adminDeleteResume } from '../../utils/api';

export default function AdminResumesList() {
  const [data, setData]     = useState({ resumes: [], total: 0, pages: 1 });
  const [page, setPage]     = useState(1);
  const [userFilter, setUserFilter] = useState('');
  const [appliedUserId, setAppliedUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  const load = (p = 1, userId = appliedUserId) => {
    setLoading(true);
    adminGetResumes(p, userId.trim())
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
    if (!confirm(`Delete resume "${title}"? This removes it for that user.`)) return;
    setDeleting(id);
    try {
      await adminDeleteResume(id);
      load(page, appliedUserId);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  const fmtDate = d => (d ? new Date(d).toLocaleDateString() : '—');

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">All resumes</h1>
          <p className="page-sub">{data.total} resume{data.total !== 1 ? 's' : ''}</p>
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
      ) : data.resumes.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon">📄</div>
          <h3>No resumes</h3>
        </div>
      ) : (
        <>
          <div className="table-wrapper card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Candidate</th>
                  <th>Owner</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.resumes.map(r => (
                  <tr key={r._id}>
                    <td><Link to={`/admin/resumes/${r._id}`} className="table-link">{r.title}</Link></td>
                    <td>{r.name || '—'}</td>
                    <td>{r.userId?.name || '—'}</td>
                    <td>{fmtDate(r.updatedAt)}</td>
                    <td className="table-actions">
                      <Link to={`/admin/resumes/${r._id}`} className="btn btn-sm btn-secondary">View</Link>
                      <button className="btn btn-sm btn-danger" disabled={deleting === r._id} onClick={() => handleDelete(r._id, r.title)}>
                        {deleting === r._id ? '…' : 'Delete'}
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
