import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router'
import { ErrorScreen } from '@/components/ErrorScreen'

/**
 * react-router `errorElement` — catches errors thrown while rendering, loading,
 * or acting on a route. Replaces react-router's default "Unexpected Application
 * Error!" page so route crashes get the same recovery UI as render-time crashes
 * caught by the top-level ErrorBoundary (main.tsx).
 */
export function RouteErrorBoundary() {
  const routeError = useRouteError()
  const navigate = useNavigate()

  const error =
    routeError instanceof Error
      ? routeError
      : new Error(
          isRouteErrorResponse(routeError)
            ? `${routeError.status} ${routeError.statusText}`
            : 'Unknown error',
        )

  return (
    <ErrorScreen
      error={error}
      onReload={() => window.location.reload()}
      onReset={() => navigate('/', { replace: true })}
    />
  )
}
