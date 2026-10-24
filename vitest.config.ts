import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.RUN_REAL_API === '1' ? configDefaults.exclude : [...configDefaults.exclude, 'tests/realapi/**'],
    testTimeout: 20000,
    hookTimeout: 20000,
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
  },
})
