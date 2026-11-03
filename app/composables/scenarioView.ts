// Display helpers for the read-only scenario views. Status names come from server/lib/scenarioStore.ts.
const LABELS: Record<string, string> = {
  REVIEW: '下書き（レビュー待ち）',
  AUDIO_PREPARING: '承認済み・音声生成中',
  AUDIO_FAILED: '承認済み・音声に失敗あり',
  READY: '承認済み・利用可能',
}

export const statusLabel = (s: string) => LABELS[s] ?? s

export function fmtTime(sec: number | null | undefined): string {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
