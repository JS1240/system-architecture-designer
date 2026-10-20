/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // The three.js scene is a lazy chunk of about 1 MB; the app shell stays small.
  build: { chunkSizeWarningLimit: 1200 },
  // Scenario-wide tests complete every scenario design, about 3 s alone and past the 5 s default when the files run in parallel.
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 20_000 },
})
