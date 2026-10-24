// Builds the Nitro server once if .output is missing (tests/app.test.ts spawns it).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export default function setup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (process.env.SKIP_BUILD === '1') return
  if (!fs.existsSync(path.join(root, '.output/server/index.mjs')) || process.env.FORCE_BUILD === '1') {
    console.log('[globalSetup] building Nuxt app for integration tests…')
    execSync('npx nuxt build', { cwd: root, stdio: 'inherit' })
  }
}
