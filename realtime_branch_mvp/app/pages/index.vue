<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { api, pollJob } from '~/composables/useApi'

const config = ref<any>(null)
const configError = ref('')
const scenarioId = ref<string | null>(null)
const row = ref<any>(null) // version shown in review
const genStatus = ref('')
const audioJobId = ref<string | null>(null)
const versions = ref<any[]>([])

const voice = reactive({ provider: '', model: '', voice: '', speed: 1.0, style_id: 'polite' })

onMounted(async () => {
  try {
    config.value = await api('GET', '/api/config')
    const vo = config.value.voice_options
    voice.provider = vo.providers[0] ?? ''
    voice.model = vo.models[0] ?? ''
    voice.voice = vo.voices[0] ?? ''
  } catch (e: any) {
    configError.value = '設定取得失敗: ' + e.message
  }
})

async function loadVersion(ver: number) {
  row.value = await api('GET', `/api/scenarios/${scenarioId.value}/versions/${ver}`)
  versions.value = (await api('GET', `/api/scenarios/${scenarioId.value}/versions`)).versions
}

async function onGenerated(result: any) {
  scenarioId.value = result.scenario_id
  await loadVersion(result.version)
}

async function onApproved(r: { job_id: string }) {
  audioJobId.value = r.job_id
  await loadVersion(row.value.version)
  await pollJob(r.job_id, () => {})
  await loadVersion(row.value.version)
}
</script>

<template>
  <div>
    <header>
      <h1>Realtime 分岐応対 MVP</h1>
      <ProviderBadges v-if="config" :providers="config.providers" />
      <p class="notice">
        ⚠ このローカルMVPは共有サービスではありません。会話中はマイク音声が OpenAI Realtime API に送信されます。
        アシスタントの発話は AI 生成音声です。Claude API・TTS・Realtime の利用には各社の料金が発生します
        （暫定分類は発話の途中音声を繰り返し送るため、音声入力の課金が増えます。割り込みモードでは再生中もマイク音声を送信します）。
      </p>
      <p v-if="configError" class="error">{{ configError }}</p>
    </header>
    <main v-if="config">
      <PolicyForm :config="config" :voice="voice" v-model:status="genStatus" @generated="onGenerated" />
      <ReviewEditor
        v-if="row"
        :scenario-id="scenarioId!"
        :row="row"
        :versions="versions"
        :voice="voice"
        @select-version="loadVersion"
        @saved="loadVersion"
        @approved="onApproved"
      />
      <AudioPrep v-if="row && row.status !== 'REVIEW'" :scenario-id="scenarioId!" :row="row" :job-id="audioJobId" @refresh="loadVersion(row.version)" />
      <ConversationPanel v-if="row" :config="config" :scenario-id="scenarioId!" :row="row" />
    </main>
  </div>
</template>
