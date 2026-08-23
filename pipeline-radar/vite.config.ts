import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Point the shared workspace package at its TypeScript source rather than
    // its built dist/. Vite compiles it like any other source file, so the web
    // build never has to wait on `npm run build -w @pipeline-radar/shared`, and
    // HMR still works when editing shared logic. The api service consumes the
    // built dist/ instead — see api/Dockerfile.
    alias: [
      {
        find: /^@pipeline-radar\/shared\/(.*)$/,
        replacement: fileURLToPath(new URL('../shared/src/$1', import.meta.url)),
      },
    ],
  },
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
