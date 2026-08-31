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
      },
      '/aviationweather': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/aviationweather/, '/api/data')
      },
      '/usgs-epqs': {
        target: 'https://epqs.nationalmap.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/usgs-epqs/, '/v1/json')
      },
      '/faa-airspace': {
        target: 'https://services6.arcgis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(
          /^\/faa-airspace/,
          '/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/Class_Airspace/FeatureServer/0/query'
        )
      }
    }
  }
});
