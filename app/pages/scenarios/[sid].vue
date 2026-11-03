<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '~/composables/useApi'
import { fmtTime, statusLabel } from '~/composables/scenarioView'

// 読み取り専用の確認画面。編集・承認・会話開始はトップ画面の既存フローで行う。
const route = useRoute()
const sid = computed(() => String(route.params.sid))
const versions = ref<any[]>([])
const ver = ref<number | null>(null)
const row = ref<any>(null)
const manifest = ref<any>(null)
const error = ref('')

async function load() {
  error.value = ''
  row.value = null
  manifest.value = null
  try {
    versions.value = (await api('GET', `/api/scenarios/${sid.value}/versions`)).versions
    if (!versions.value.length) throw new Error('シナリオが見つかりません')
    const q = Number(route.query.v)
    ver.value = versions.value.some((v) => v.version === q) ? q : versions.value[versions.value.length - 1].version
    row.value = await api('GET', `/api/scenarios/${sid.value}/versions/${ver.value}`)
    manifest.value = await api('GET', `/api/scenarios/${sid.value}/versions/${ver.value}/manifest`)
  } catch (e: any) {
    error.value = e.message
  }
}
watch(() => [route.params.sid, route.query.v], load, { immediate: true })

const approved = computed(() => !!row.value?.approved_at)
const nodeLabel = (id: string) => {
  const s = row.value?.scenario
  const n = s?.nodes.find((x: any) => x.id === id) ?? s?.control_nodes.find((x: any) => x.id === id)
  return n ? `${n.label} (${id})` : id
}
const audioOf = (kind: 'node' | 'control', id: string) => manifest.value?.entries?.[`${kind}:${id}`]
const audioText = (kind: 'node' | 'control', id: string) => {
  const e = audioOf(kind, id)
  return e ? (e.status === 'ready' ? '音声あり' : e.status === 'failed' ? '音声失敗' : '音声未生成') : '音声なし'
}
const summary = computed(() => row.value?.audio_summary)
const selectVersion = (e: Event) => navigateTo({ query: { v: (e.target as HTMLSelectElement).value } })
</script>

<template>
  <main data-testid="scenario-detail">
    <p v-if="error" class="error" data-testid="detail-error">{{ error }}</p>
    <p v-else-if="!row" class="hint">読み込み中…</p>
    <template v-else>
      <section>
        <h2>{{ row.scenario.title }} <span class="tag">{{ statusLabel(row.status) }}</span></h2>
        <p class="hint">ID: {{ sid }} ／ 作成: {{ fmtTime(row.created_at) }} ／ 承認: {{ approved ? fmtTime(row.approved_at) : '未承認' }} ／ 生成: {{ row.generator }}</p>
        <label style="max-width:240px">版
          <select :value="ver" data-testid="version-select" @change="selectVersion">
            <option v-for="v in versions" :key="v.version" :value="v.version">v{{ v.version }}（{{ statusLabel(v.status) }}）</option>
          </select>
        </label>
        <p class="hint">読み取り専用の画面です。編集・承認・会話開始は「新規作成画面」で行います。</p>
      </section>

      <section>
        <h3>応対方針の入力文</h3>
        <p class="v" data-testid="source-instruction">{{ row.scenario.source_instruction || '（記録なし）' }}</p>
        <template v-if="row.scenario.source_facts"><span class="k">事実/FAQ</span><p class="v">{{ row.scenario.source_facts }}</p></template>
        <template v-if="row.scenario.constraints.length">
          <span class="k">禁止事項・制約</span>
          <ul><li v-for="c in row.scenario.constraints" :key="c">{{ c }}</li></ul>
        </template>
        <span class="k">設計メモ</span><p class="v">{{ row.scenario.design_notes }}</p>
      </section>

      <section>
        <h3>事前生成音声</h3>
        <p data-testid="audio-summary">
          <template v-if="summary && summary.total">{{ summary.ready }} / {{ summary.total }} 件 生成済み（失敗 {{ summary.failed }}、未生成 {{ summary.pending }}）</template>
          <template v-else>なし（承認前、または音声未生成）</template>
        </p>
      </section>

      <section>
        <h3>{{ approved ? '承認版の発話文' : '発話文（下書き。未承認）' }}</h3>
        <div v-for="n in row.scenario.nodes" :key="n.id" class="node">
          <strong>{{ n.label }}</strong> <span class="tag">{{ n.id }}</span>
          <span v-if="n.id === row.scenario.entry_node_id" class="tag">入口</span>
          <span v-if="n.terminal" class="tag">終端</span>
          <span class="tag">{{ audioText('node', n.id) }}</span>
          <p class="v">{{ n.assistant_text }}</p>
        </div>
        <div v-for="c in row.scenario.control_nodes" :key="c.id" class="node control">
          <strong>{{ c.label }}</strong> <span class="tag">{{ c.id }}</span> <span class="tag">{{ c.kind }} / {{ c.action }}</span>
          <span class="tag">{{ audioText('control', c.id) }}</span>
          <p class="v">{{ c.assistant_text }}</p>
        </div>
      </section>

      <section>
        <h3>分岐グラフ</h3>
        <div class="tbl-scroll"><table data-testid="graph-table">
          <thead><tr><th>ノード</th><th>分岐</th><th>種別</th><th>遷移先</th></tr></thead>
          <tbody>
            <template v-for="n in row.scenario.nodes" :key="n.id">
              <tr v-if="n.edges.length === 0"><td>{{ nodeLabel(n.id) }}</td><td colspan="3" class="hint">{{ n.terminal ? '（終端）' : '（分岐なし）' }}</td></tr>
              <tr v-for="(e, i) in n.edges" :key="n.id + e.id">
                <td v-if="i === 0" :rowspan="n.edges.length">{{ nodeLabel(n.id) }}</td>
                <td>{{ e.label }}<span class="k">{{ e.intent_description }}</span></td>
                <td>{{ e.kind }}</td>
                <td>{{ nodeLabel(e.target_node_id) }}</td>
              </tr>
            </template>
          </tbody>
        </table></div>
      </section>
    </template>
  </main>
</template>
