import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  adminGetUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeactivateUser,
  adminResetPassword
} from '../../utils/api';

const emptyForm = { name: '', password: '', email: '', isAdmin: false, openaiApiKey: '' };

export default function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(false);
  const [pwdModal, setPwdModal] = useState(null); // user id for reset
  const [form, setForm]       = useState(emptyForm);
  const [newPwd, setNewPwd]   = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  const load = () => {
    setLoading(true);
    adminGetUsers().then(r => setUsers(r.data)).catch(console.error).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async e => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await adminCreateUser(form);
      setModal(false);
      setForm(emptyForm);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPwd = async e => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await adminResetPassword(pwdModal, newPwd);
      setPwdModal(null);
      setNewPwd('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password');
    } finally {
      setSaving(false);
    }
  };

  const toggleAdmin = async u => {
    if (!confirm(`${u.isAdmin ? 'Remove' : 'Grant'} admin for ${u.name}?`)) return;
    await adminUpdateUser(u._id, { isAdmin: !u.isAdmin });
    load();
  };

  const toggleActive = async u => {
    try {
      if (u.isActive) await adminDeactivateUser(u._id);
      else await adminUpdateUser(u._id, { isActive: true });
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Action failed');
    }
  };

  const fmtDate = d => new Date(d).toLocaleDateString();

  return (
    <div className="admin-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-sub">{users.length} account{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setModal(true); setError(''); setForm(emptyForm); }}>+ New user</button>
      </div>

      {loading ? (
        <div className="loading-inline"><div className="spinner" /></div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u._id} className={!u.isActive ? 'row-inactive' : ''}>
                  <td><strong>{u.name}</strong></td>
                  <td>{u.email || '—'}</td>
                  <td>
                    <span className={`badge ${u.isAdmin ? 'badge-admin' : 'badge-user'}`}>
                      {u.isAdmin ? 'Admin' : 'User'}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${u.isActive ? 'badge-active' : 'badge-inactive'}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>{fmtDate(u.createdAt)}</td>
                  <td className="table-actions">
                    <button className="btn btn-sm btn-secondary" onClick={() => toggleAdmin(u)}>
                      {u.isAdmin ? 'Remove admin' : 'Make admin'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => { setPwdModal(u._id); setNewPwd(''); setError(''); }}>
                      Reset password
                    </button>
                    <button
                      className={`btn btn-sm ${u.isActive ? 'btn-danger' : 'btn-secondary'}`}
                      onClick={() => toggleActive(u)}
                      disabled={u.isActive && String(u._id) === String(me?._id)}
                      title={String(u._id) === String(me?._id) ? 'Use another admin to deactivate your account' : ''}
                    >
                      {u.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className="modal">
            <div className="modal-header">
              <h3>Create user</h3>
              <button type="button" className="btn-icon" onClick={() => setModal(false)}>✕</button>
            </div>
            <form onSubmit={handleCreate} className="modal-body">
              <div className="form-group">
                <label>Username <span className="required">*</span></label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label>Password <span className="required">*</span></label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>OpenAI API key <span className="optional">(optional)</span></label>
                <input value={form.openaiApiKey} onChange={e => setForm(f => ({ ...f, openaiApiKey: e.target.value }))} placeholder="sk-…" />
              </div>
              <div className="form-group checkbox-group">
                <label>
                  <input type="checkbox" checked={form.isAdmin} onChange={e => setForm(f => ({ ...f, isAdmin: e.target.checked }))} />
                  &nbsp; Grant admin
                </label>
              </div>
              {error && <div className="error-banner">{error}</div>}
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pwdModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setPwdModal(null); }}>
          <div className="modal">
            <div className="modal-header">
              <h3>Reset password</h3>
              <button type="button" className="btn-icon" onClick={() => setPwdModal(null)}>✕</button>
            </div>
            <form onSubmit={handleResetPwd} className="modal-body">
              <div className="form-group">
                <label>New password <span className="required">*</span></label>
                <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} minLength={6} required />
              </div>
              {error && <div className="error-banner">{error}</div>}
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setPwdModal(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
