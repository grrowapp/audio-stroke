export class ApiError extends Error {
  constructor(message: string, public detail: any, public status: number) {
    super(message)
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const opt: RequestInit = { method, headers: {} }
  if (body !== undefined) {
    ;(opt.headers as Record<string, string>)['Content-Type'] = 'application/json'
    opt.body = JSON.stringify(body)
  }
  const r = await fetch(path, opt)
  const data: any = await r.json().catch(() => ({}))
  if (!r.ok) {
    const d = data?.data ?? data?.detail ?? data
    const msg = typeof d === 'string' ? d : d?.message ? d.message + (d.missing ? `: ${d.missing.join(', ')}` : '') : data?.statusMessage ?? `HTTP ${r.status}`
    throw new ApiError(msg, d, r.status)
  }
  return data as T
}

export async function pollJob(jobId: string, onUpdate: (j: any) => void): Promise<any> {
  for (;;) {
    const j = await api('GET', `/api/jobs/${jobId}`)
    onUpdate(j)
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(j.status)) return j
    await new Promise((r) => setTimeout(r, 600))
  }
}
