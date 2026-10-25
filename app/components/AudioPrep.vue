<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, pollJob } from '~/composables/useApi'

const props = defineProps<{ scenarioId: string; row: any; jobId: string | null }>()
const emit = defineEmits<{ refresh: [] }>()

const manifest = ref<any>(null)
const progress = ref('')
const currentJob = ref<string | null>(null)

async function load() {
  manifest.value = await api('GET', `/api/scenarios/${props.scenarioId}/versions/${props.row.version}/manifest`)
  const s = manifest.value.summary
  progress.value = `状態 ${manifest.value.status}${manifest.value.mock_audio ? '（MOCK音声：トーンのみ・発話ではありません）' : ''}\n` +
    `完了 ${s.ready}/${s.total}、失敗 ${s.failed}、未完了 ${s.pending}、キャッシュ再利用 ${s.cache_hits}、総文字数 ${s.chars}（生成対象 ${s.chars_to_generate ?? '-'}）`
}

async function track(jobId: string) {
  currentJob.value = jobId
  const j = await pollJob(jobId, (j) => {
    const p = j.progress ?? {}
    progress.value = `AUDIO_PREPARING… 完了 ${p.done ?? 0}/${p.total ?? '?'}、失敗 ${p.failed ?? 0}、キャッシュ再利用 ${p.cache_hits ?? 0}、生成文字数 ${p.chars_to_generate ?? '-'}${p.mock ? '（MOCK）' : ''}`
  })
  await load()
  if (j.status !== 'succeeded') progress.value += `\nジョブ結果: ${j.status} ${j.error ?? ''}`
  emit('refresh')
}

watch(() => props.row, () => load(), { immediate: true })
watch(() => props.jobId, (j) => { if (j && j !== currentJob.value) track(j) }, { immediate: true })

async function cancel() {
  if (currentJob.value) await api('POST', `/api/jobs/${currentJob.value}/cancel`, {})
}

async function retry() {
  try {
    const r = await api('POST', `/api/scenarios/${props.scenarioId}/versions/${props.row.version}/audio/retry`, {})
    await track(r.job_id)
  } catch (e: any) { progress.value += '\n再試行できません: ' + e.message }
}

function play(audioId: string) {
  if (!/^[0-9a-f]{64}$/.test(audioId)) return
  new Audio(`/api/audio/${audioId}`).play().catch((err) => alert('再生失敗: ' + err))
}
</script>

<template>
  <section id="secAudio">
    <h2>3. 音声の事前生成 <span class="tag">v{{ row.version }}</span></h2>
    <div id="audioProgress" class="status">{{ progress }}</div>
    <div class="row">
      <button type="button" class="secondary" @click="cancel">ジョブ中止</button>
      <button type="button" class="secondary" @click="retry">失敗分だけ再試行</button>
    </div>
    <table v-if="manifest">
      <thead><tr><th>発話</th><th>文</th><th>状態</th><th>長さ</th><th>確認</th></tr></thead>
      <tbody>
        <tr v-for="e in Object.values(manifest.entries) as any[]" :key="e.utterance_key">
          <td>{{ e.utterance_key }}</td><td>{{ e.text }}<span v-if="e.tts_text && e.tts_text !== e.text" class="hint"><br>読み替え後: {{ e.tts_text }}</span></td>
          <td>{{ e.status }}{{ e.cache_hit ? '（キャッシュ）' : '' }}{{ e.error ? '：' + e.error : '' }}</td>
          <td>{{ e.duration_ms ? (e.duration_ms / 1000).toFixed(1) + 's' : '' }}</td>
          <td><button type="button" class="secondary" :disabled="e.status !== 'ready'" @click="play(e.audio_id)">再生</button></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
