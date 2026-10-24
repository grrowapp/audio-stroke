import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/realapi/**'],
    testTimeout: 20000,
    hookTimeout: 20000,
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
  },
})
