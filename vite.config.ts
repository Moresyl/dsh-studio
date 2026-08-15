import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The Tauri dev server must be reachable at a fixed address, because the Rust
// side is configured with that exact URL and cannot follow a port change.
const DEV_PORT = 1420

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    watch: {
      ignored: [
        // Rust sources have their own rebuild loop.
        '**/src-tauri/**',
        // Editing prose reloaded the running app, which is worse than useless
        // mid-install: it throws away the console you were reading.
        '**/docs/**',
        '**/.workflow/**',
        '**/*.md',
      ],
    },
  },
  // Both WebView2 and WKWebView are evergreen enough that transpiling further
  // down only costs bundle size.
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
})
