import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from './ThemeContext'
import { initPosthog, capture } from './posthog'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 1,
    },
  },
});

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

async function bootstrap() {
  // Non-blocking: fetch telemetry config and init Posthog if enabled.
  // Any failure (server down, network error) is silently ignored.
  try {
    const res = await fetch(`${API_URL}/api/telemetry/config`);
    if (res.ok) {
      const { installationId, telemetryEnabled } = await res.json();
      if (telemetryEnabled && installationId) {
        initPosthog(installationId as string);
        capture('board_viewed');
      }
    }
  } catch {
    // Telemetry must never block the app from starting
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

bootstrap();
