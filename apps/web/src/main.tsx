import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { registerServiceWorker } from './features/sync/register-service-worker.js';
import { AuthProvider } from './features/auth/auth-context.js';
import { DomainDataProvider } from './features/domains/domain-data.js';
import { router } from './router.js';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst',
      retry: 1,
      staleTime: 30_000,
    },
    mutations: { networkMode: 'offlineFirst', retry: 0 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('EMDO root element is missing.');

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <DomainDataProvider clearPrivateMemory={() => queryClient.clear()}>
          <RouterProvider router={router} />
        </DomainDataProvider>
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
);

void registerServiceWorker();
