import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const nav = [
  { to: '/dashboard',  label: 'Dashboard', icon: '▦' },
  { to: '/resumes',    label: 'Resumes',   icon: '📄' },
  { to: '/interviews', label: 'Interviews',icon: '🎙' }
];

export default function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = () => {
    signOut();
    window.location.reload();
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">M</span>
          <span className="brand-name">Mongtro</span>
        </div>

        <nav className="sidebar-nav">
          {nav.map(({ to, label, icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span className="nav-icon">{icon}</span>
              <span>{label}</span>
            </NavLink>
          ))}
          {user?.isAdmin && (
            <NavLink
              to="/admin/dashboard"
              className={() => `nav-item${location.pathname.startsWith('/admin') ? ' active' : ''}`}
            >
              <span className="nav-icon">🛡</span>
              <span>Admin</span>
            </NavLink>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <div className="user-avatar">{user?.name?.[0]?.toUpperCase()}</div>
            <div className="user-info">
              <div className="user-name">{user?.name}</div>
              <div className="user-role">{user?.isAdmin ? 'Admin' : 'User'}</div>
            </div>
          </div>
          <button className="sign-out-btn" onClick={handleSignOut}>Sign out</button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
