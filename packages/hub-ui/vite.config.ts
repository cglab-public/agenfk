import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.HUB_UI_PORT || '5180'),
    proxy: {
      '/v1': 'http://localhost:4000',
      '/auth': 'http://localhost:4000',
      '/setup': 'http://localhost:4000',
      '/healthz': 'http://localhost:4000',
    },
  },
});
