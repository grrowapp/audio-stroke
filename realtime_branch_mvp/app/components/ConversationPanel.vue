<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useConversation } from '~/composables/useConversation'

const props = defineProps<{ config: any; scenarioId: string; row: any }>()
const conv = useConversation()
const st = conv.st

const rt = reactive({
  silence_duration_ms: 600, final_grace_ms: 200, preview_enabled: true, preview_min_audio_ms: 800, preview_interval_ms: 800, preview_max_per_utterance: 3,
  barge_in_enabled: false, barge_in_confirm_ms: 250,
})
const mockPreview = ref('ctrl_unclear')
const mockFinal = ref('ctrl_unclear')

const ready = computed(() => props.row.status === 'READY' && props.row.validation?.ok)
const mockOptions = computed(() => [...(st.branches[st.mockNode] ?? []), 'ctrl_unclear', 'ctrl_end_request', 'invalid_branch_for_test'])
const micLabel = computed(() => {
  if (st.playing && st.micEnabled) return '再生中／マイク送信中（割り込み可）'
  if (st.playing) return '再生中／マイク送信停止'
  return st.micEnabled ? (st.mock ? '送信中（MOCK無音）' : '送信中') : '停止'
})

function start() {
  conv.start({ scenarioId: props.scenarioId, version: props.row.version, runtime: { ...rt } })
}

function exportLog() {
  if (!st.sessionId) return
  if (!confirm('評価ログには音声・全文文字起こしは含みませんが、ID・タイミング・分岐選択・エラー等から個人に関わる情報が推測される可能性があります。ダウンロードしますか？')) return
  location.href = `/api/sessions/${st.sessionId}/log.jsonl`
}
</script>

<template>
  <section id="secConv">
    <h2>4. 会話実行 <span class="tag">{{ st.versionLabel || `v${row.version}` }}</span></h2>
    <p class="hint">
      既定は半二重です：アシスタント音声の再生中はマイク送信を停止します。
      「発話開始からの分岐予測」（暫定分類）と「アシスタント発話への割り込み（barge-in）」は別機能です。
      割り込みは下の実行時設定で有効化でき、再生中もマイク音声を送信し、確認猶予を超えて続いた発話で再生を止めてその発話を回答として扱います（エコーは端末のエコーキャンセルと確認猶予で抑えます）。
    </p>
    <details id="runtimeDetails">
      <summary>実行時設定</summary>
      <div class="row">
        <label>silence_duration_ms <input id="rsSilence" v-model.number="rt.silence_duration_ms" type="number"></label>
        <label>再発話確認猶予 ms <input v-model.number="rt.final_grace_ms" type="number"></label>
        <label>暫定分類 <input id="rsPreview" v-model="rt.preview_enabled" type="checkbox"></label>
        <label>暫定: 最小音声 ms <input id="rsPrevMin" v-model.number="rt.preview_min_audio_ms" type="number"></label>
        <label>暫定: 間隔 ms <input id="rsPrevInt" v-model.number="rt.preview_interval_ms" type="number"></label>
        <label>暫定: 最大回数 <input v-model.number="rt.preview_max_per_utterance" type="number"></label>
        <label>割り込み（barge-in） <input id="rsBargeIn" v-model="rt.barge_in_enabled" type="checkbox"></label>
        <label>割り込み確認猶予 ms <input id="rsBargeConfirm" v-model.number="rt.barge_in_confirm_ms" type="number"></label>
      </div>
    </details>
    <div class="row">
      <button id="btnStart" type="button" :disabled="!ready || st.connected" @click="start">会話開始</button>
      <button id="btnStop" type="button" class="danger" @click="conv.stop()">停止</button>
      <button id="btnSkip" type="button" class="secondary" @click="conv.skip()">再生中断（回答へ）</button>
      <button v-if="st.phase === 'PLAYBACK_ERROR'" id="btnRetryPlay" type="button" class="secondary" @click="conv.retryPlayback()">再生を再試行</button>
    </div>
    <div id="startHint" class="hint">
      {{ ready ? `v${row.version} は READY です（開始時にサーバーで再確認します）。` : `v${row.version} は ${row.status} のため開始できません（承認・音声生成完了・検証合格が必要です）。` }}
    </div>
    <div v-if="st.mock && st.connected" id="mockPanel" class="mock">
      <strong>MOCK Realtime</strong>（音声は理解しません。発話区間と分類結果を手動で指定するデモです）
      <div class="row">
        <label>暫定で返す分岐 <select id="mockPreview" v-model="mockPreview"><option v-for="o in mockOptions" :key="o" :value="o">{{ o }}</option></select></label>
        <label>最終で返す分岐 <select id="mockFinal" v-model="mockFinal"><option v-for="o in mockOptions" :key="o" :value="o">{{ o }}</option></select></label>
        <button id="btnMockStart" type="button" class="secondary" @click="conv.mockVad('start', mockPreview, mockFinal)">MOCK: 発話開始</button>
        <button id="btnMockStop" type="button" class="secondary" @click="conv.mockVad('stop', mockPreview, mockFinal)">MOCK: 発話終了</button>
      </div>
    </div>
    <div class="grid">
      <div><span class="k">状態</span><span id="cPhase" class="v big">{{ st.phase }}</span></div>
      <div><span class="k">マイク</span><span id="cMic" class="v">{{ micLabel }}</span></div>
      <div><span class="k">モード</span><span class="v mode" :class="{ duplex: st.bargeInEnabled }">{{ st.bargeInEnabled ? '割り込み可（全二重）' : '半二重' }}</span></div>
      <div><span class="k">現在ノード</span><span id="cNode" class="v">{{ st.nodeLabel }} ({{ st.nodeId }})  turn {{ st.turnId }} / gen {{ st.generation }}</span></div>
      <div><span class="k">今の発話文</span><span id="cText" class="v">{{ st.text }}</span></div>
      <div><span class="k">暫定分岐（表示と先読みのみ）</span><span id="cPreview" class="v">{{ st.preview }}</span></div>
      <div><span class="k">確定分岐</span><span id="cFinal" class="v">{{ st.final }}</span></div>
      <div><span class="k">次の発話文</span><span id="cNext" class="v">{{ st.nextText }}</span></div>
      <div><span class="k">音声キャッシュ</span><span id="cCache" class="v">{{ st.cache }}</span></div>
      <div><span class="k">中断された発話</span><span id="cInterrupted" class="v">{{ st.interruptedInfo }}</span></div>
    </div>
    <div id="convError" class="error">{{ st.error }}</div>
    <h3>遅延指標（測定境界）</h3>
    <table id="metricsTable">
      <thead><tr><th>指標</th><th>最新値 ms</th><th>測定境界</th></tr></thead>
      <tbody>
        <tr v-for="(d, k) in config.metric_definitions" :key="k"><td>{{ k }}</td><td>{{ st.metrics[k] ?? '' }}</td><td>{{ d }}</td></tr>
      </tbody>
    </table>
    <div id="counters" class="hint">counters: {{ JSON.stringify(st.counters) }}<span v-if="st.usage"> / Realtime usage: {{ JSON.stringify(st.usage) }}</span></div>
    <h3>イベント</h3>
    <ol id="eventLog" class="log"><li v-for="(e, i) in st.events" :key="i">{{ e }}</li></ol>
    <button id="btnExport" type="button" class="secondary" :disabled="!st.sessionId" @click="exportLog">評価ログ（JSONL）をダウンロード</button>
  </section>
</template>
