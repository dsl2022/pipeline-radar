import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mirror of production routing (CloudFront /api/* -> ALB): forward
    // /api to the local proxy service. Run it with `npm run dev` in api/.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
