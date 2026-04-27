import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';

import Dashboard from './pages/Dashboard';
import Resumes from './pages/Resumes';
import ResumeForm from './pages/ResumeForm';
import Interviews from './pages/Interviews';
import InterviewDetail from './pages/InterviewDetail';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminUsers from './pages/admin/AdminUsers';
import AdminInterviewsList from './pages/admin/AdminInterviewsList';
import AdminInterviewDetail from './pages/admin/AdminInterviewDetail';
import AdminResumesList from './pages/admin/AdminResumesList';
import AdminResumeDetail from './pages/admin/AdminResumeDetail';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/resumes" element={<Resumes />} />
              <Route path="/resumes/new" element={<ResumeForm />} />
              <Route path="/resumes/:id/edit" element={<ResumeForm />} />
              <Route path="/interviews" element={<Interviews />} />
              <Route path="/interviews/:id" element={<InterviewDetail />} />
            </Route>

            <Route path="/admin" element={<AdminRoute />}>
              <Route element={<AdminLayout />}>
                <Route index element={<Navigate to="/admin/dashboard" replace />} />
                <Route path="dashboard" element={<AdminDashboard />} />
                <Route path="users" element={<AdminUsers />} />
                <Route path="interviews" element={<AdminInterviewsList />} />
                <Route path="interviews/:id" element={<AdminInterviewDetail />} />
                <Route path="resumes" element={<AdminResumesList />} />
                <Route path="resumes/:id" element={<AdminResumeDetail />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
