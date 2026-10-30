import { createBrowserRouter, Navigate } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { ProtectedAdminRoute } from '@/components/ProtectedAdminRoute'
import { AuditPage } from '@/routes/AuditPage'
import { DashboardPage } from '@/routes/DashboardPage'
import { HealthPage } from '@/routes/HealthPage'
import { LoginPage } from '@/routes/login'
import { LoginTwoFactorPage } from '@/routes/login-2fa'
import { LoginTwoFactorEnrollPage } from '@/routes/login-2fa-enroll'
import { OrgDetailPage } from '@/routes/OrgDetailPage'
import { OrgsListPage } from '@/routes/OrgsListPage'
import { UsagePage } from '@/routes/UsagePage'

// react-router 7 library mode (createBrowserRouter), matching apps/web's
// documented convention — NOT v7 framework mode / file-based routing.
//
// `/login`, `/login/2fa`, `/login/2fa/enroll` are public siblings of the protected
// subtree — no admin token exists yet when an admin is on any of them. `ProtectedAdminRoute`
// gates everything below it; `AppShell` is composed as its child route element,
// per `ProtectedAdminRoute`'s own doc comment. The real page bodies replace the former
// `ScaffoldPage` placeholder; paths match `nav-groups.ts`.
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/login/2fa', element: <LoginTwoFactorPage /> },
  { path: '/login/2fa/enroll', element: <LoginTwoFactorEnrollPage /> },
  {
    element: <ProtectedAdminRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'orgs', element: <OrgsListPage /> },
          { path: 'orgs/:id', element: <OrgDetailPage /> },
          { path: 'usage', element: <UsagePage /> },
          { path: 'health', element: <HealthPage /> },
          { path: 'audit', element: <AuditPage /> },
        ],
      },
    ],
  },
])
