<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '~/composables/useApi'
import { fmtTime, statusLabel } from '~/composables/scenarioView'

const route = useRoute()
const items = ref<any[]>([])
const loaded = ref(false)
const error = ref('')
const open = ref(true)
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    items.value = (await api('GET', '/api/scenarios/summaries')).scenarios
    error.value = ''
  } catch (e: any) {
    error.value = '一覧の取得に失敗: ' + e.message
  } finally {
    loaded.value = true
  }
}

onMounted(() => {
  // 狭い画面（スマホ / macOS アプリの小窓）では初期状態で閉じる
  if (window.matchMedia('(max-width: 720px)').matches) open.value = false
  load()
  timer = setInterval(load, 15000)
})
onBeforeUnmount(() => clearInterval(timer))
watch(() => route.fullPath, () => {
  load()
  if (window.matchMedia('(max-width: 720px)').matches) open.value = false
})
</script>

<template>
  <aside class="sidebar" :class="{ collapsed: !open }" data-testid="scenario-sidebar">
    <button class="sb-toggle secondary" data-testid="sidebar-toggle" :aria-expanded="open" aria-controls="sb-body" @click="open = !open">
      {{ open ? '◀ 閉じる' : '▶ シナリオ' }}
    </button>
    <div v-show="open" id="sb-body" class="sb-body">
      <div class="sb-head">
        <strong>作成済みシナリオ</strong>
        <button class="secondary sb-refresh" title="再読み込み" @click="load">↻</button>
      </div>
      <NuxtLink to="/" class="sb-new">＋ 新規作成画面へ</NuxtLink>
      <p v-if="error" class="error" data-testid="sidebar-error">{{ error }}</p>
      <p v-else-if="!loaded" class="hint">読み込み中…</p>
      <p v-else-if="items.length === 0" class="hint" data-testid="sidebar-empty">作成済みのシナリオはまだありません。</p>
      <ul v-else class="sb-list">
        <li v-for="s in items" :key="s.scenario_id">
          <NuxtLink :to="`/scenarios/${s.scenario_id}`" class="sb-item" :class="{ active: route.params.sid === s.scenario_id }" data-testid="sidebar-item">
            <span class="sb-title">{{ s.title || s.scenario_id }}</span>
            <span class="sb-meta">{{ fmtTime(s.created_at) }}</span>
            <span class="sb-meta">
              <span class="tag" :class="'st-' + s.status">{{ statusLabel(s.status) }}</span>
              <span class="tag">v{{ s.latest }}</span>
            </span>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </aside>
</template>
