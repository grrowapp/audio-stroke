<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '~/composables/useApi'

const props = defineProps<{ scenarioId: string; row: any; versions: any[]; voice: any }>()
const emit = defineEmits<{ selectVersion: [ver: number]; saved: [ver: number]; approved: [r: { job_id: string }] }>()

const KEYS = ['title', 'entry_node_id', 'nodes', 'control_nodes', 'policy', 'design_notes']
const draft = ref<any>(null)
const validation = ref<any>(null)
const status = ref('')
const reviewed = ref(false)
const rawJson = ref('')
const selectedVersion = ref(0)

const bodyOf = (s: any) => Object.fromEntries(KEYS.map((k) => [k, s[k]]))
const dirty = computed(() => props.row && draft.value && JSON.stringify(bodyOf(draft.value)) !== JSON.stringify(bodyOf(props.row.scenario)))

watch(() => props.row, (r) => {
  if (!r) return
  draft.value = JSON.parse(JSON.stringify(r.scenario))
  validation.value = r.validation
  reviewed.value = false
  selectedVersion.value = r.version
  rawJson.value = JSON.stringify(bodyOf(draft.value), null, 2)
}, { immediate: true })

const nodeIds = computed<string[]>(() => draft.value?.nodes.map((n: any) => n.id) ?? [])
const ctrlIds = computed<string[]>(() => draft.value?.control_nodes.map((c: any) => c.id) ?? [])
const lines = (a: string[]) => (a ?? []).join('\n')
const setLines = (obj: any, key: string, v: string) => { obj[key] = v.split('\n').map((x) => x.trim()).filter(Boolean) }

async function validate() {
  try {
    validation.value = await api('POST', `/api/scenarios/${props.scenarioId}/validate`, { base_version: props.row.version, scenario: bodyOf(draft.value) })
    status.value = '検証しました（未保存）。'
  } catch (e: any) { status.value = 'エラー: ' + e.message }
}

async function saveVersion() {
  try {
    const r = await api('POST', `/api/scenarios/${props.scenarioId}/versions`, { base_version: props.row.version, scenario: bodyOf(draft.value) })
    status.value = `v${r.version} として保存しました（実行中のセッションは元の版のままです）。`
    emit('saved', r.version)
  } catch (e: any) {
    status.value = '保存できません: ' + e.message
    if (e.detail?.validation) validation.value = e.detail.validation
  }
}

async function approve() {
  if (dirty.value) { status.value = '未保存の編集があります。先に「新しい版として保存」してください（承認は保存済みの版に対して行います）。'; return }
  if (!reviewed.value) { status.value = '内容確認のチェックを入れてください。'; return }
  try {
    const r = await api('POST', `/api/scenarios/${props.scenarioId}/versions/${props.row.version}/approve`, { voice: { ...props.voice }, confirm_reviewed: true })
    status.value = `v${props.row.version} を承認し音声生成を開始しました（${r.mock ? 'MOCK音声' : 'TTS'}、概算 ${r.summary.chars_to_generate} 文字、キャッシュ再利用 ${r.summary.cache_hits} 件）。`
    emit('approved', r)
  } catch (e: any) {
    status.value = '承認できません: ' + e.message
    if (e.detail?.validation) validation.value = e.detail.validation
  }
}

function applyRaw() {
  try {
    const parsed = JSON.parse(rawJson.value)
    draft.value = { ...draft.value, ...parsed }
    status.value = 'JSON を反映しました（未保存）。'
  } catch (e: any) { status.value = 'JSON が不正です: ' + e.message }
}
</script>

<template>
  <section id="secReview">
    <h2>2. 生成結果のレビュー・編集 <span id="reviewVersion" class="tag">{{ row.scenario_id }} v{{ row.version }}</span></h2>
    <p class="warn">これは draft です。予測返答例は網羅ではなく仮説です。内容（特に事実・約束表現）を必ず確認してください。</p>
    <div class="row">
      <label>版
        <select id="versionSelect" :value="selectedVersion" @change="emit('selectVersion', Number(($event.target as HTMLSelectElement).value))">
          <option v-for="v in versions" :key="v.version" :value="v.version">v{{ v.version }} {{ v.status }}{{ v.parent_version ? ` (v${v.parent_version}から編集)` : '' }}</option>
        </select>
      </label>
      <span id="versionStatus" class="tag">{{ row.status }}</span>
      <span class="tag">{{ row.is_mock_generated ? 'MOCK生成' : row.generator === 'edit' ? '手動編集' : 'Claude生成' }}</span>
    </div>
    <div id="validationBox" class="validation" v-if="validation">
      <div :class="validation.ok ? 'ok' : 'e'">{{ validation.ok ? 'グラフ検証: 合格' : `グラフ検証: エラー ${validation.errors.length} 件` }}</div>
      <div v-for="(e, i) in validation.errors" :key="'e' + i" class="e">✗ [{{ e.code }}] {{ e.message }}</div>
      <div v-for="(w, i) in validation.warnings" :key="'w' + i" class="w">! [{{ w.code }}] {{ w.message }}</div>
      <div class="hint" v-if="validation.stats">統計: {{ JSON.stringify(validation.stats) }}</div>
    </div>
    <div class="hint" v-if="draft?.design_notes">設計メモ: {{ draft.design_notes }}</div>

    <div id="editor" v-if="draft">
      <label>タイトル<input v-model="draft.title"></label>
      <label>入口ノード<select v-model="draft.entry_node_id"><option v-for="id in nodeIds" :key="id" :value="id">{{ id }}</option></select></label>
      <div v-for="n in draft.nodes" :key="n.id" class="node">
        <h4>ノード {{ n.id }}{{ n.id === draft.entry_node_id ? '（入口）' : '' }}{{ n.terminal ? '（終端）' : '' }}</h4>
        <label>ラベル<input v-model="n.label"></label>
        <label>発話文（このノードに入った時に一度だけ再生）<textarea v-model="n.assistant_text" rows="2" /></label>
        <label class="check"><input v-model="n.terminal" type="checkbox"> 終端（再生後に会話を閉じる）</label>
        <div class="row">
          <label>fallback（聞き返し）<select v-model="n.fallback_node_id"><option :value="null">（なし）</option><option v-for="id in ctrlIds" :key="id" :value="id">{{ id }}</option></select></label>
          <label>no-input（無応答）<select v-model="n.no_input_node_id"><option :value="null">（なし）</option><option v-for="id in ctrlIds" :key="id" :value="id">{{ id }}</option></select></label>
        </div>
        <table v-if="n.edges.length" class="edges">
          <thead><tr><th>ID</th><th>ラベル/種別/遷移先</th><th>意図・条件（1行1件）</th><th>想定返答例</th><th>否定例</th></tr></thead>
          <tbody>
            <tr v-for="e in n.edges" :key="e.id">
              <td>{{ e.id }}</td>
              <td>
                <input v-model="e.label">
                <select v-model="e.kind"><option v-for="k in ['normal', 'confirm', 'deny', 'correction']" :key="k" :value="k">{{ k }}</option></select>
                <select v-model="e.target_node_id"><option v-for="id in nodeIds" :key="id" :value="id">{{ id }}</option></select>
              </td>
              <td><textarea v-model="e.intent_description" /><textarea :value="lines(e.match_conditions)" @input="setLines(e, 'match_conditions', ($event.target as HTMLTextAreaElement).value)" /></td>
              <td><textarea :value="lines(e.positive_examples)" @input="setLines(e, 'positive_examples', ($event.target as HTMLTextAreaElement).value)" /></td>
              <td><textarea :value="lines(e.negative_examples)" @input="setLines(e, 'negative_examples', ($event.target as HTMLTextAreaElement).value)" /></td>
            </tr>
          </tbody>
        </table>
        <div v-if="n.edges.length" class="hint">※ 全ノードで「終了希望」と「聞き取り不明（fallback）」はアプリが自動で受け付けます。</div>
      </div>
      <div v-for="c in draft.control_nodes" :key="c.id" class="node control">
        <h4>制御ノード {{ c.id }}（{{ c.kind }} / {{ c.action }}{{ c.goto_node_id ? ' → ' + c.goto_node_id : '' }}）</h4>
        <label>発話文<textarea v-model="c.assistant_text" rows="2" /></label>
      </div>
      <h4>ポリシー</h4>
      <div class="row">
        <label v-for="k in ['max_turns', 'max_clarify_per_node', 'max_no_input_per_node', 'no_input_timeout_ms']" :key="k">{{ k }}<input v-model.number="draft.policy[k]" type="number"></label>
      </div>
    </div>
    <details>
      <summary>JSON で直接編集（ノード追加・削除など構造変更用）</summary>
      <textarea id="rawJson" v-model="rawJson" rows="16" spellcheck="false" />
      <button type="button" class="secondary" @click="applyRaw">JSON をエディタへ反映</button>
    </details>
    <div class="row">
      <button id="btnValidate" type="button" class="secondary" @click="validate">検証</button>
      <button id="btnSaveVersion" type="button" class="secondary" @click="saveVersion">新しい版として保存</button>
    </div>
    <label class="check"><input id="chkReviewed" v-model="reviewed" type="checkbox"> 表示中の版の発話文・分岐条件・予測返答例を確認しました</label>
    <button id="btnApprove" type="button" @click="approve">内容を承認して音声生成</button>
    <div id="reviewStatus" class="status">{{ status }}</div>
  </section>
</template>
