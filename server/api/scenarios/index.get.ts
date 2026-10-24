import { defineEventHandler } from 'h3'
import { services } from '../../lib/services'

export default defineEventHandler(() => ({ scenarios: services().store.listScenarios() }))
