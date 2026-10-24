// Build the service container at startup (recovers interrupted jobs/sessions).
import { services } from '../lib/services'

export default defineNitroPlugin(() => {
  const s = services()
  const r = s.recovered
  if (r.jobs || r.versions || r.sessions) console.log(`[startup] recovered after restart: jobs=${r.jobs} versions=${r.versions} sessions=${r.sessions}`)
  console.log(`[startup] providers: scenario=${s.generator.name} tts=${s.synthesizer.name} realtime=${s.settings.realtimeProvider}`)
})
