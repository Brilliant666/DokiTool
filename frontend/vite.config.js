import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
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
