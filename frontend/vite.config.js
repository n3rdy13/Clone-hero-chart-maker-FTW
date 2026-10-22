import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site at /<repo>/. The Pages workflow sets
  // BASE_PATH; local runs keep serving from /.
  base: process.env.BASE_PATH || '/',
  server: {
    port: 6969,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
});
