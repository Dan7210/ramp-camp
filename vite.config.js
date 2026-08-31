import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  assetsInclude: ['**/*.csv'],
  server: {
    proxy: {
      '/overpass': {
        target: 'https://overpass-api.de/api/interpreter',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/overpass/, '')
      }
    }
  }
});