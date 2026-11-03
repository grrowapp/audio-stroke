import { defineEventHandler } from 'h3'
import { services } from '../../lib/services'

// Read-only overview for the sidebar (GET /api/scenarios keeps its original shape for cli/phone.ts).
export default defineEventHandler(() => ({ scenarios: services().store.listScenarioSummaries() }))
