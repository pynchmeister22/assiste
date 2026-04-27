import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const adminNav = [
  { to: '/admin/dashboard', label: 'Overview', icon: '▦' },
  { to: '/admin/users', label: 'Users', icon: '👤' },
  { to: '/admin/interviews', label: 'All interviews', icon: '🎙' },
  { to: '/admin/resumes', label: 'All resumes', icon: '📄' }
];

export default function AdminLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = () => {
    signOut();
    window.location.reload();
  };

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <span className="brand-icon">A</span>
          <div>
            <div className="admin-brand-title">Admin</div>
            <div className="admin-brand-sub">Mongtro</div>
          </div>
        </div>

        <nav className="admin-sidebar-nav">
          {adminNav.map(({ to, label, icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `admin-nav-item${isActive ? ' active' : ''}`}>
              <span className="nav-icon">{icon}</span>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="admin-sidebar-footer">
          <button type="button" className="btn btn-secondary full-width" onClick={() => navigate('/dashboard')}>
            ← Back to app
          </button>
          <div className="user-chip compact">
            <div className="user-avatar small">{user?.name?.[0]?.toUpperCase()}</div>
            <div className="user-info">
              <div className="user-name">{user?.name}</div>
            </div>
          </div>
          <button type="button" className="sign-out-btn" onClick={handleSignOut}>Sign out</button>
        </div>
      </aside>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
