import { defineEventHandler } from 'h3'
import { idParam, intParam, versionOr404, versionView } from '../../../../../lib/api'
import { services } from '../../../../../lib/services'

export default defineEventHandler((event) => versionView(versionOr404(services(), idParam(event, 'sid'), intParam(event, 'ver'))))
