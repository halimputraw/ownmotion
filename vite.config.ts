import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the packaged app can load from file://.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    strictPort: true,
  },
})
