import { describe, expect, it } from 'vitest'
import { buildManifest } from '../server/lib/audioStore'
import { makeScenario, GeneratedScenarioSchema } from '../server/lib/scenarioSchema'
import { REVIEW } from '../server/lib/scenarioStore'
import { validateScenario } from '../server/lib/scenarioValidator'
import { MOCK_VOICE, makeStores, readyManifest, sampleBody, sampleScenario, tmpSettings } from './helpers'

const insert = (store: any, sc: any) => store.insertVersion(sc, validateScenario(sc), 'mock', null)

describe('Store.listScenarioSummaries (sidebar, read-only)', () => {
  it('empty store → empty list', () => {
    const { store } = makeStores(tmpSettings())
    expect(store.listScenarioSummaries()).toEqual([])
  })

  it('one row per scenario describing its newest version, newest first', () => {
    const { store, audio } = makeStores(tmpSettings())
    const a1 = sampleScenario()
    insert(store, a1)
    const a2 = makeScenario(GeneratedScenarioSchema.parse({ ...sampleBody(), title: '改訂版' }), { scenario_id: a1.scenario_id, version: 2 })
    insert(store, a2)
    const m = readyManifest(a1, audio)
    store.approveVersion(a1.scenario_id, 1, MOCK_VOICE, m)
    store.setVersionStatus(a1.scenario_id, 1, 'READY')
    const b = makeScenario(GeneratedScenarioSchema.parse(sampleBody()), { scenario_id: 'scn_fedcba9876543210', version: 1 })
    insert(store, b)

    const list = store.listScenarioSummaries()
    expect(list).toHaveLength(2)
    expect(list.map((x) => x.scenario_id).sort()).toEqual([a1.scenario_id, b.scenario_id].sort())
    const sa = list.find((x) => x.scenario_id === a1.scenario_id)!
    expect(sa).toMatchObject({ title: '改訂版', latest: 2, status: REVIEW, approved_versions: 1 })
    expect(sa.created_at).toBeLessThanOrEqual(sa.updated_at)
    const sb = list.find((x) => x.scenario_id === b.scenario_id)!
    expect(sb).toMatchObject({ latest: 1, status: REVIEW, approved_versions: 0, audio: { total: 0, ready: 0 } })
    // listing must not mutate anything
    expect(store.getVersion(a1.scenario_id, 1)!.status).toBe('READY')
  })

  it('reports audio ready/total of the newest version', () => {
    const { store, audio } = makeStores(tmpSettings())
    const sc = sampleScenario()
    insert(store, sc)
    const m = buildManifest(sc, MOCK_VOICE, audio)
    store.approveVersion(sc.scenario_id, 1, MOCK_VOICE, m)
    const total = Object.keys(m.entries).length
    expect(store.listScenarioSummaries()[0].audio).toEqual({ total, ready: 0 })
    store.saveManifest(sc.scenario_id, 1, readyManifest(sc, audio))
    expect(store.listScenarioSummaries()[0].audio).toEqual({ total, ready: total })
  })
})
