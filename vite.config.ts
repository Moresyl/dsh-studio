import { fileURLToPath, URL } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
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
        // The download page is its own static site, deployed by its own
        // workflow. It shares nothing with this bundle but a palette.
        '**/website/**',
        '**/.workflow/**',
        '**/*.md',
      ],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '.github/scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      // Deterministic browser logic only. IPC bindings are generated one-line
      // adapters whose behavior is owned by the Rust command tests; React view
      // composition is verified by typecheck/build and desktop smoke tests.
      include: [
        'src/lib/bridge.ts',
        'src/lib/crash.ts',
        'src/lib/errors.ts',
        'src/lib/fuzzy.ts',
        'src/lib/updater.ts',
        'src/lib/usage.ts',
        'src/state/rates.ts',
        'src/state/terminals.ts',
        'src/state/update.ts',
        'src/state/workspace.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      reporter: ['text', 'json-summary'],
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
