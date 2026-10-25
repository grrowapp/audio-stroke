/**
 * Conversation WebSocket: /ws?session_id=…
 * One connection per session (single use). Binary frames are PCM16 @ 24 kHz
 * from the browser; text frames are JSON control / ack messages.
 */
import { defineWebSocketHandler } from 'h3'
import type { Peer } from 'crossws'
import { manifestMissing, type Manifest } from '../lib/audioStore'
import { checkAuth } from '../lib/auth'
import { SessionMetrics } from '../lib/metrics'
import { createEngine } from '../core/factory'
import { runtimeFromUser } from '../core/runtime'
import type { Engine } from '../core/types'
import { ID_RE, READY } from '../lib/scenarioStore'
import { services } from '../lib/services'
import path from 'node:path'

const engines = new WeakMap<Peer, Engine>()
/** First byte of every binary audio frame from the browser (PCM16 follows). */
export const AUDIO_TAG = 0x01

function sendJson(peer: Peer, msg: Record<string, unknown>) {
  peer.send(JSON.stringify(msg))
}

export default defineWebSocketHandler({
  upgrade(request) {
    const svc = services()
    const host = request.headers.get('host') ?? ''
    const origin = request.headers.get('origin') ?? ''
    if (!svc.allowedHosts.has(host) || !svc.allowedOrigins.has(origin)) return new Response('forbidden', { status: 403 })
    // Browsers send cookies (not necessarily the cached Basic header) on the upgrade; the cookie set by 01.auth covers it.
    if (checkAuth({ authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie') }, svc.settings) === 'unauthorized') return new Response('unauthorized', { status: 401 })
    const sid = new URL(request.url).searchParams.get('session_id') ?? ''
    if (!ID_RE.test(sid) || !svc.store.getSession(sid)) return new Response('not found', { status: 404 })
  },

  async open(peer) {
    const svc = services()
    const sid = new URL(peer.request.url).searchParams.get('session_id') ?? ''
    const s = ID_RE.test(sid) ? svc.store.getSession(sid) : null
    if (!s) {
      peer.close(1008, 'no session')
      return
    }
    if (svc.engines.size >= svc.settings.maxConcurrentSessions) {
      sendJson(peer, { type: 'finished', phase: 'ERROR', reason: 'busy', message: `別の会話セッションが接続中です（同時 ${svc.settings.maxConcurrentSessions} 件まで）。` })
      peer.close(1000)
      return
    }
    if (!svc.store.claimSession(sid)) {
      sendJson(peer, { type: 'finished', phase: 'ERROR', reason: 'session_used', message: 'このセッションは使用済みです。新しく開始してください。' })
      peer.close(1000)
      return
    }
    const row = svc.store.getVersion(s.scenario_id, s.version)!
    const sc = row.scenario
    if (row.status !== READY || manifestMissing(row.manifest as Manifest, svc.audio, sc).length) {
      sendJson(peer, { type: 'finished', phase: 'ERROR', reason: 'not_ready', message: 'シナリオ版の準備が完了していません。' })
      svc.store.endSession(sid, 'error', 'not_ready')
      peer.close(1000)
      return
    }
    const metrics = new SessionMetrics(path.join(svc.settings.dataDir, 'logs'), sid)
    let engine: Engine
    try {
      engine = createEngine({
        sessionId: sid, scenario: sc, manifest: row.manifest as Manifest, settings: runtimeFromUser(s.runtime), metrics,
        sendBrowser: (msg) => sendJson(peer, msg), audio: svc.audio, transportFactory: svc.transportFactory, app: svc.settings,
      })
    } catch (e: any) {
      sendJson(peer, { type: 'finished', phase: 'ERROR', reason: 'config', message: String(e.message) })
      svc.store.endSession(sid, 'error', 'config')
      metrics.close({ end_reason: 'config' })
      peer.close(1000)
      return
    }
    engines.set(peer, engine)
    svc.engines.set(sid, engine)
    engine.run().finally(() => {
      svc.engines.delete(sid)
      engines.delete(peer)
      svc.store.endSession(sid, engine.phase === 'FINISHED' ? 'finished' : engine.phase.toLowerCase(), engine.endReason)
      try { peer.close(1000) } catch { /* already closed */ }
    })
  },

  message(peer, message) {
    const engine = engines.get(peer)
    if (!engine) return
    const svc = services()
    // crossws hands both text and binary frames over as Buffers, so audio frames carry a
    // leading 0x01 tag byte (never valid as the first byte of JSON) — see AUDIO_TAG in the client.
    const raw = message.uint8Array()
    if (raw.length >= 1 && raw[0] === AUDIO_TAG) {
      engine.pushBrowserAudio(raw.subarray(1))
      return
    }
    if (raw.length > svc.settings.maxWsTextBytes) {
      engine.pushBrowserJson({ type: 'stop' })
      return
    }
    let msg: unknown
    try {
      msg = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return
    }
    if (msg && typeof msg === 'object' && !String((msg as any).type ?? '').startsWith('_')) engine.pushBrowserJson(msg as { type: string })
  },

  close(peer) {
    engines.get(peer)?.pushBrowserJson({ type: '_disconnect' })
  },

  error(peer) {
    engines.get(peer)?.pushBrowserJson({ type: '_disconnect' })
  },
})
