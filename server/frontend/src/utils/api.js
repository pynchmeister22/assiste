import axios from 'axios';

const api = axios.create({
  baseURL: '/api'
});

// Attach JWT token from localStorage to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Default JSON Content-Type breaks multipart uploads (multer never sees `pdf`).
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  return config;
});

// Redirect to login on 401
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.reload();
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (name, password) => api.post('/auth/login', { name, password });
export const getMe = () => api.get('/auth/user');

// ── Users (admin — legacy paths, still on /api/users) ─────────────────────────
export const getUsers = () => api.get('/users');
export const createUser = (data) => api.post('/users', data);
export const updateUser = (id, data) => api.patch(`/users/${id}`, data);
export const deleteUser = (id) => api.delete(`/users/${id}`);

// ── Admin console (/api/admin) ────────────────────────────────────────────────
export const adminGetStats = () => api.get('/admin/stats');
export const adminGetUsers = () => api.get('/admin/users');
export const adminCreateUser = (data) => api.post('/admin/users', data);
export const adminUpdateUser = (id, data) => api.patch(`/admin/users/${id}`, data);
export const adminResetPassword = (id, password) =>
  api.post(`/admin/users/${id}/reset-password`, { password });
export const adminDeactivateUser = (id) => api.delete(`/admin/users/${id}`);

export const adminGetInterviews = (page = 1, userId = '') => {
  const q = new URLSearchParams({ page: String(page) });
  if (userId) q.set('userId', userId);
  return api.get(`/admin/interviews?${q}`);
};
export const adminGetInterview = (id) => api.get(`/admin/interviews/${id}`);
export const adminDeleteInterview = (id) => api.delete(`/admin/interviews/${id}`);

export const adminGetResumes = (page = 1, userId = '') => {
  const q = new URLSearchParams({ page: String(page) });
  if (userId) q.set('userId', userId);
  return api.get(`/admin/resumes?${q}`);
};
export const adminGetResume = (id) => api.get(`/admin/resumes/${id}`);
export const adminDeleteResume = (id) => api.delete(`/admin/resumes/${id}`);
export const getApiKeys = () => api.get('/users/api-keys');

// ── Resumes ───────────────────────────────────────────────────────────────────
export const getResumes = () => api.get('/resumes');
/** @param {FormData} formData — append file as field name `pdf` */
export const parseResumePdf = (formData) => api.post('/resumes/parse-pdf', formData);
export const getResume = (id) => api.get(`/resumes/${id}`);
export const createResume = (data) => api.post('/resumes', data);
export const updateResume = (id, data) => api.put(`/resumes/${id}`, data);
export const deleteResume = (id) => api.delete(`/resumes/${id}`);

// ── Interview / Chat History ──────────────────────────────────────────────────
export const getInterviews = (page = 1) => api.get(`/chat-history?page=${page}`);
export const getInterview = (id) => api.get(`/chat-history/${id}`);
export const deleteInterview = (id) => api.delete(`/chat-history/${id}`);
export const getInterviewStats = () => api.get('/chat-history/stats/summary');
