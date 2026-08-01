import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { applyThemeToDocument, resolveInitialTheme } from './hooks/useTheme';
import './index.css';

(function applyInitialTheme() {
  try {
    const theme = resolveInitialTheme(window.localStorage, window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyThemeToDocument(theme);
  } catch {
    /* non-browser env — ignore */
  }
})();

const qc = new QueryClient({ defaultOptions: { queries: { refetchInterval: 30_000, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
