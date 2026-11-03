/** Compatibility barrel: the engine now lives in server/core (see docs/CORE_PROTOCOL.md). */
export * from '../core/pcmRing'
export * from '../core/runtime'
export * from '../core/transports'
export * from '../core/decision'
export * from '../core/realtimeBackend'
export * from '../core/engine'
export type { Phase, Engine, EngineHost, BrowserSend } from '../core/types'
export { nodeHost } from '../core/types'
