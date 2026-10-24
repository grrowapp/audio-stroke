import { defineEventHandler } from 'h3'
import { idParam } from '../../../../lib/api'
import { services } from '../../../../lib/services'

export default defineEventHandler((event) => ({ versions: services().store.listVersions(idParam(event, 'sid')) }))
