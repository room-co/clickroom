import React from 'react'
import { ErrorScreen } from '@/components/ErrorScreen'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

/**
 * Render-time boundary for errors OUTSIDE the router tree (e.g. RouterProvider
 * itself failing to mount). Errors thrown while rendering a route are caught by
 * react-router's own per-route boundary first — see RouteErrorBoundary — since
 * that sits closer to the throw than this ancestor.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo })
    // In production you'd ship this to Sentry / your error pipeline here
    console.error('[Clickroom] Uncaught error:', error, errorInfo)
  }

  reload = () => window.location.reload()

  reset = () => this.setState({ error: null, errorInfo: null })

  render() {
    const { error, errorInfo } = this.state
    if (!error) return this.props.children
    return (
      <ErrorScreen
        error={error}
        componentStack={errorInfo?.componentStack}
        onReload={this.reload}
        onReset={this.reset}
      />
    )
  }
}
