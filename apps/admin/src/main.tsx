import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { TrpcProvider } from '@/lib/trpc-provider'
import { router } from './app/router'
import './styles/index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

createRoot(rootElement).render(
  <TrpcProvider>
    <RouterProvider router={router} />
  </TrpcProvider>,
)
