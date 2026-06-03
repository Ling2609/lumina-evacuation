import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// =============================================================================
// LUMINA — Vite Configuration
//
// Key fix: define Node.js globals that the 'mqtt' npm package references.
// Without this, Vite throws "process is not defined" → white screen.
// This is the most reliable fix regardless of mqtt version.
// =============================================================================
export default defineConfig({
  plugins: [react()],

  define: {
    // Polyfill Node.js globals for browser environment
    global:         'globalThis',
    'process.env':  {},
    'process.version': '"v18.0.0"',
  },

  server: {
    // Allow access from other devices on the same network (booth demo / iPad)
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,   // fail loud if port taken — prevents silent bump to 5174 at booth

    // Proxy API calls to Flask — avoids CORS issues during development
    // Remove this if you're using CORS(app) in Flask (you already are)
    proxy: {
      '/api': {
        target:    'http://127.0.0.1:5001',
        changeOrigin: true,
      },
      '/video_feed': {
        target:    'http://127.0.0.1:5001',
        changeOrigin: true,
      },
    },
  },

  build: {
    // Warn if any chunk exceeds 800KB (helps catch accidental large imports)
    chunkSizeWarningLimit: 800,
  },
})
