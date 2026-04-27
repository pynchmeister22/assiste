import { createContext, useContext, useState, useEffect } from 'react';
import { login, getMe } from '../utils/api';

const STATIC_USER = 'moon';
const STATIC_PASS = '123456';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setAuthError(null);
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const r = await getMe();
          if (!cancelled) setUser(r.data);
          if (!cancelled) setLoading(false);
          return;
        } catch {
          localStorage.removeItem('token');
        }
      }

      try {
        const { data } = await login(STATIC_USER, STATIC_PASS);
        localStorage.setItem('token', data.token);
        if (!cancelled) setUser(data.user);
      } catch (e) {
        if (!cancelled) {
          setUser(null);
          setAuthError(e.response?.data?.error || 'Could not reach the API. Is the backend running?');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, []);

  const signIn = (token, userData) => {
    localStorage.setItem('token', token);
    setUser(userData);
  };

  const signOut = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  const retryAuth = () => {
    setLoading(true);
    setAuthError(null);
    localStorage.removeItem('token');
    window.location.reload();
  };

  return (
    <AuthContext.Provider value={{ user, loading, authError, signIn, signOut, retryAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
