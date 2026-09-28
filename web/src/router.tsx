import { createBrowserRouter, Navigate } from 'react-router';
import { Layout, RouteError } from './components/Layout';
import { AssetsPage } from './pages/Assets';
import { CostsPage } from './pages/Costs';
import { CreatePage } from './pages/Create';
import { Dashboard } from './pages/Dashboard';
import { JobsPage } from './pages/Jobs';
import { ProjectsPage } from './pages/Projects';
import { ProvidersPage } from './pages/Providers';
import { SettingsPage } from './pages/Settings';
import { TemplatesPage } from './pages/Templates';
import { VoicesPage } from './pages/Voices';
import { Studio } from './studio/Studio';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:id', element: <Navigate to="storyboard" replace /> },
      { path: 'projects/:id/:tab', element: <Studio /> },
      { path: 'create', element: <CreatePage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'assets', element: <AssetsPage /> },
      { path: 'voices', element: <VoicesPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'costs', element: <CostsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
