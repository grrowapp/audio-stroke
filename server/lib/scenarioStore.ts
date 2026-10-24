/**
 * Local SQLite persistence (node:sqlite, single process). Versions are
 * immutable once saved: an edit always creates a new version; a running
 * session keeps the version it pinned at creation time.
 */
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Scenario } from './scenarioSchema'

export const REVIEW = 'REVIEW' // draft, awaiting human review/approval
export const AUDIO_PREPARING = 'AUDIO_PREPARING' // approved, audio job running
export const AUDIO_FAILED = 'AUDIO_FAILED' // approved, some audio missing (retry possible)
export const READY = 'READY' // approved + validated + all audio ready

export const QUEUED = 'queued'
export const RUNNING = 'running'
export const SUCCEEDED = 'succeeded'
export const FAILED = 'failed'
export const CANCELED = 'canceled'
export const INTERRUPTED = 'interrupted'
export const TERMINAL_JOB = new Set([SUCCEEDED, FAILED, CANCELED, INTERRUPTED])

export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`
export const ID_RE = /^[a-z]+_[0-9a-f]{16}$/

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scenario_versions (
  scenario_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  data_json TEXT NOT NULL, validation_json TEXT NOT NULL, generator TEXT NOT NULL,
  parent_version INTEGER, voice_json TEXT, manifest_json TEXT,
  created_at REAL NOT NULL, approved_at REAL, PRIMARY KEY (scenario_id, version));
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, params_json TEXT NOT NULL,
  progress_json TEXT NOT NULL, result_json TEXT, error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS audio_assets (
  audio_id TEXT PRIMARY KEY, path TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL, duration_ms INTEGER, settings_json TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  request_id TEXT, runtime_json TEXT NOT NULL, created_at REAL NOT NULL, ended_at REAL, end_reason TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_request ON sessions(request_id);
`

export interface VersionRow {
  scenario_id: string
  version: number
  status: string
  scenario: Scenario
  validation: Record<string, any>
  generator: string
  parent_version: number | null
  voice: Record<string, any> | null
  manifest: Record<string, any> | null
  created_at: number
  approved_at: number | null
}

export interface JobRow {
  id: string
  kind: string
  status: string
  params: Record<string, any>
  progress: Record<string, any>
  result: Record<string, any> | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface AssetRow {
  audio_id: string
  path: string
  mime: string
  byte_length: number
  content_sha256: string
  duration_ms: number | null
  settings_json: string
  created_at: number
}

export interface SessionRow {
  id: string
  scenario_id: string
  version: number
  status: string
  request_id: string | null
  runtime: Record<string, any>
  created_at: number
  ended_at: number | null
  end_reason: string | null
}

const now = () => Date.now() / 1000

export class Store {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(SCHEMA_SQL)
  }

  close() {
    this.db.close()
  }

  /** Jobs running at shutdown are marked interrupted, never silently ready. */
  recoverAfterRestart(): { jobs: number; versions: number; sessions: number } {
    const t = now()
    const c1 = this.db.prepare('UPDATE jobs SET status=?, error=?, updated_at=? WHERE status IN (?,?)').run(INTERRUPTED, 'サーバー再起動により中断されました', t, QUEUED, RUNNING).changes
    const c2 = this.db.prepare('UPDATE scenario_versions SET status=? WHERE status=?').run(AUDIO_FAILED, AUDIO_PREPARING).changes
    const c3 = this.db.prepare("UPDATE sessions SET status='aborted', end_reason='server_restart', ended_at=? WHERE status IN ('created','active')").run(t).changes
    return { jobs: Number(c1), versions: Number(c2), sessions: Number(c3) }
  }

  // ---------------- scenarios
  nextVersion(scenarioId: string): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM scenario_versions WHERE scenario_id=?').get(scenarioId) as { v: number | null }
    return (r?.v ?? 0) + 1
  }

  insertVersion(s: Scenario, validation: object, generator: string, parentVersion: number | null) {
    this.db.prepare('INSERT INTO scenario_versions(scenario_id, version, status, data_json, validation_json, generator, parent_version, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.scenario_id, s.version, REVIEW, JSON.stringify(s), JSON.stringify(validation), generator, parentVersion, now())
  }

  getVersion(scenarioId: string, version: number): VersionRow | null {
    const r = this.db.prepare('SELECT * FROM scenario_versions WHERE scenario_id=? AND version=?').get(scenarioId, version) as any
    if (!r) return null
    return {
      scenario_id: r.scenario_id, version: Number(r.version), status: r.status,
      scenario: JSON.parse(r.data_json), validation: JSON.parse(r.validation_json), generator: r.generator,
      parent_version: r.parent_version == null ? null : Number(r.parent_version),
      voice: r.voice_json ? JSON.parse(r.voice_json) : null, manifest: r.manifest_json ? JSON.parse(r.manifest_json) : null,
      created_at: r.created_at, approved_at: r.approved_at ?? null,
    }
  }

  listVersions(scenarioId: string) {
    return this.db.prepare('SELECT scenario_id, version, status, generator, parent_version, created_at, approved_at FROM scenario_versions WHERE scenario_id=? ORDER BY version').all(scenarioId) as any[]
  }

  listScenarios() {
    return this.db.prepare('SELECT scenario_id, MAX(version) AS latest, MAX(created_at) AS updated FROM scenario_versions GROUP BY scenario_id ORDER BY updated DESC').all() as any[]
  }

  setVersionStatus(scenarioId: string, version: number, status: string) {
    this.db.prepare('UPDATE scenario_versions SET status=? WHERE scenario_id=? AND version=?').run(status, scenarioId, version)
  }

  approveVersion(scenarioId: string, version: number, voice: object, manifest: object) {
    this.db.prepare('UPDATE scenario_versions SET status=?, voice_json=?, manifest_json=?, approved_at=? WHERE scenario_id=? AND version=?')
      .run(AUDIO_PREPARING, JSON.stringify(voice), JSON.stringify(manifest), now(), scenarioId, version)
  }

  saveManifest(scenarioId: string, version: number, manifest: object) {
    this.db.prepare('UPDATE scenario_versions SET manifest_json=? WHERE scenario_id=? AND version=?').run(JSON.stringify(manifest), scenarioId, version)
  }

  // ---------------- jobs
  createJob(kind: string, params: Record<string, unknown>): string {
    const id = newId('job')
    const t = now()
    this.db.prepare('INSERT INTO jobs(id, kind, status, params_json, progress_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, kind, QUEUED, JSON.stringify(params), '{}', t, t)
    return id
  }

  updateJob(id: string, u: { status?: string; progress?: Record<string, unknown>; result?: Record<string, unknown>; error?: string | null }) {
    const sets = ['updated_at=?']
    const args: unknown[] = [now()]
    if (u.status !== undefined) { sets.push('status=?'); args.push(u.status) }
    if (u.progress !== undefined) { sets.push('progress_json=?'); args.push(JSON.stringify(u.progress)) }
    if (u.result !== undefined) { sets.push('result_json=?'); args.push(JSON.stringify(u.result)) }
    if (u.error !== undefined) { sets.push('error=?'); args.push(u.error) }
    args.push(id)
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?`).run(...(args as any[]))
  }

  getJob(id: string): JobRow | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any
    if (!r) return null
    return { id: r.id, kind: r.kind, status: r.status, params: JSON.parse(r.params_json), progress: JSON.parse(r.progress_json), result: r.result_json ? JSON.parse(r.result_json) : null, error: r.error ?? null, created_at: r.created_at, updated_at: r.updated_at }
  }

  // ---------------- audio
  putAsset(audioId: string, path: string, mime: string, byteLength: number, sha: string, durationMs: number | null, settings: Record<string, unknown>) {
    this.db.prepare('INSERT OR REPLACE INTO audio_assets(audio_id, path, mime, byte_length, content_sha256, duration_ms, settings_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(audioId, path, mime, byteLength, sha, durationMs, JSON.stringify(settings), now())
  }

  getAsset(audioId: string): AssetRow | null {
    const r = this.db.prepare('SELECT * FROM audio_assets WHERE audio_id=?').get(audioId) as any
    return r ? { ...r, byte_length: Number(r.byte_length), duration_ms: r.duration_ms == null ? null : Number(r.duration_ms) } : null
  }

  // ---------------- sessions
  /** Returns [session_id, created]. Same request_id → same session (double-click safe). */
  createSession(scenarioId: string, version: number, runtime: Record<string, unknown>, requestId: string | null): [string, boolean] {
    if (requestId) {
      const r = this.db.prepare('SELECT id FROM sessions WHERE request_id=?').get(requestId) as any
      if (r) return [r.id, false]
    }
    const id = newId('sess')
    this.db.prepare('INSERT INTO sessions(id, scenario_id, version, status, request_id, runtime_json, created_at) VALUES (?,?,?,?,?,?,?)').run(id, scenarioId, version, 'created', requestId, JSON.stringify(runtime), now())
    return [id, true]
  }

  getSession(id: string): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    if (!r) return null
    const { runtime_json, ...rest } = r
    return { ...rest, version: Number(r.version), runtime: JSON.parse(runtime_json) }
  }

  /** Atomically move created → active. Sessions are single-use. */
  claimSession(id: string): boolean {
    return Number(this.db.prepare("UPDATE sessions SET status='active' WHERE id=? AND status='created'").run(id).changes) === 1
  }

  endSession(id: string, status: string, reason: string) {
    this.db.prepare('UPDATE sessions SET status=?, end_reason=?, ended_at=? WHERE id=?').run(status, reason, now(), id)
  }
}
