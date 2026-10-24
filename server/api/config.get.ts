import { defineEventHandler } from 'h3'
import { FIXED_RULES, SAMPLE_INSTRUCTION, STYLE_PRESETS, effectiveTtsFormat, effectiveTtsModels, effectiveTtsVoices } from '../lib/config'
import { METRIC_DEFINITIONS } from '../lib/metrics'
import { RUNTIME_BOUNDS, defaultRuntime } from '../lib/realtimeSession'
import { services } from '../lib/services'

export default defineEventHandler(() => {
  const { settings: s, generator, synthesizer, recovered } = services()
  return {
    providers: {
      scenario: { name: generator.name, mock: generator.isMock, model: generator.model },
      tts: { name: synthesizer.name, mock: synthesizer.isMock },
      realtime: { name: s.realtimeProvider, mock: s.realtimeProvider !== 'openai', model: s.realtimeModel || null, preview_mode: s.previewAudioMode },
    },
    voice_options: {
      providers: [s.ttsProvider], models: effectiveTtsModels(s), voices: effectiveTtsVoices(s), format: effectiveTtsFormat(s),
      speed: { min: s.speedMin, max: s.speedMax, default: 1.0 },
      styles: Object.entries(STYLE_PRESETS).map(([id, text]) => ({ id, text })),
    },
    limits: { max_depth: s.maxDepthLimit, max_nodes: s.maxNodesLimit, max_branches: s.maxBranchesLimit },
    runtime_defaults: defaultRuntime(),
    runtime_bounds: RUNTIME_BOUNDS,
    sample_instruction: SAMPLE_INSTRUCTION,
    fixed_rules: FIXED_RULES,
    metric_definitions: METRIC_DEFINITIONS,
    recovered_after_restart: recovered,
  }
})
