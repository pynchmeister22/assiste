import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getInterviews, deleteInterview } from '../utils/api';

export default function Interviews() {
  const [data, setData]     = useState({ sessions: [], total: 0, pages: 1 });
  const [page, setPage]     = useState(1);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  const load = (p = 1) => {
    setLoading(true);
    getInterviews(p)
      .then(r => { setData(r.data); setPage(p); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => load(1), []);

  const handleDelete = async (id, title) => {
    if (!confirm(`Delete interview "${title}"?`)) return;
    setDeleting(id);
    try {
      await deleteInterview(id);
      load(page);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    } finally {
      setDeleting(null);
    }
  };

  const fmtDate = d => d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const countLines = t => (t?.interviewer?.length || 0) + (t?.user?.length || 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Interview History</h2>
          <p className="page-sub">{data.total} session{data.total !== 1 ? 's' : ''} recorded</p>
        </div>
      </div>

      {loading ? (
        <div className="loading-inline"><div className="spinner" /></div>
      ) : data.sessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎙</div>
          <h3>No interviews yet</h3>
          <p>Start the extension during an interview — sessions sync here automatically.</p>
        </div>
      ) : (
        <>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Resume</th>
                  <th>Lines</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map(s => (
                  <tr key={s._id}>
                    <td>
                      <Link to={`/interviews/${s._id}`} className="table-link">{s.title || 'Untitled'}</Link>
                    </td>
                    <td>{s.resumeId?.title || '—'}</td>
                    <td>{countLines(s.transcripts)}</td>
                    <td>{fmtDate(s.startedAt)}</td>
                    <td className="table-actions">
                      <Link to={`/interviews/${s._id}`} className="btn btn-sm btn-secondary">View</Link>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(s._id, s.title)}
                        disabled={deleting === s._id}
                      >
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
              <button className="btn btn-sm btn-secondary" onClick={() => load(page - 1)} disabled={page <= 1}>← Prev</button>
              <span className="page-info">Page {page} of {data.pages}</span>
              <button className="btn btn-sm btn-secondary" onClick={() => load(page + 1)} disabled={page >= data.pages}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
