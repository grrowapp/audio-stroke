// Platform health check (no auth, no secrets). Host guard still applies.
import { defineEventHandler } from 'h3'

export default defineEventHandler(() => ({ ok: true }))
