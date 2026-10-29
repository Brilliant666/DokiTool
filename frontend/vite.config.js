import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  build: {
    manifest: true,
    // File hashes give every visual asset a safe long-lived cache key.
    assetsInlineLimit: 0,
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  },
  server: {
    proxy: {
      '/api': {
        target: loadEnv(mode, process.cwd(), '').DEV_API_TARGET || 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
  },
}))
