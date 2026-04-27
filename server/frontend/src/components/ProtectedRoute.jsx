import { Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute() {
  const { user, loading, authError, retryAuth } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p style={{ marginTop: 16, color: 'var(--text-muted)', fontSize: 14 }}>Connecting…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo">
            <div className="brand-icon large">M</div>
            <h1>Mongtro</h1>
            <p>Dashboard</p>
          </div>
          <div className="error-banner" style={{ marginBottom: 16 }}>{authError || 'Unable to sign in.'}</div>
          <p className="section-desc" style={{ textAlign: 'center', marginBottom: 16 }}>
            The app uses a fixed account. Ensure the backend is running, then retry.
          </p>
          <button type="button" className="btn btn-primary full-width" onClick={retryAuth}>Retry</button>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
