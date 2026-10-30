import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toaster } from '@/components/ui/sonner'
import { initAnalytics } from '@/lib/analytics'
import { TrpcProvider } from '@/lib/trpc-provider'
import { router } from './app/router'
import './styles/index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

initAnalytics()

createRoot(rootElement).render(
  <TrpcProvider>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
    <Toaster />
  </TrpcProvider>,
)
