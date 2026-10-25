<script setup lang="ts">
import { reactive, ref } from 'vue'
import { api, pollJob } from '~/composables/useApi'

const props = defineProps<{ config: any; voice: any }>()
const emit = defineEmits<{ generated: [result: any] }>()
const status = defineModel<string>('status', { default: '' })

const form = reactive({ call_direction: props.config.call_directions?.default ?? 'inbound', instruction: '', facts: '', prohibitions: '', first_utterance: '', max_depth: 4, max_nodes: 20, max_branches: 4 })
const directionOptions = () => {
  const cd = props.config.call_directions
  if (!cd) return [{ value: 'inbound', label: 'inbound', disabled: false }]
  return [...cd.implemented.map((d: string) => ({ value: d, label: `${d}：${cd.labels[d]}`, disabled: false })),
    ...cd.planned.map((d: string) => ({ value: d, label: `${d}：${cd.labels[d]}`, disabled: true }))]
}
const busy = ref(false)

async function generate() {
  if (!form.instruction.trim()) { status.value = '応対目的・指示を入力してください。'; return }
  busy.value = true
  try {
    const { job_id, mock } = await api('POST', '/api/scenarios/generate', { ...form, instruction: form.instruction.trim(), first_utterance: form.first_utterance.trim() })
    status.value = `生成ジョブ開始 (${mock ? 'MOCK' : 'Claude API'})`
    const j = await pollJob(job_id, (j) => { status.value = `GENERATING… ${j.status} ${j.progress.stage ?? ''}${mock ? '（MOCK）' : ''}` })
    if (j.status !== 'succeeded') {
      status.value = `生成失敗: ${j.error ?? j.status}` + (j.result?.details ? '\n' + [].concat(j.result.details).join('\n') : '')
      return
    }
    const usage = (j.result.usage ?? []).map((u: any) => `in=${u.input_tokens ?? '-'} out=${u.output_tokens ?? '-'}`).join(', ')
    status.value = `生成完了（${j.result.mock ? 'MOCK' : j.result.model}、試行 ${j.result.attempts} 回、修復 ${j.result.repairs} 回${usage ? '、usage ' + usage : ''}）`
    emit('generated', j.result)
  } catch (e: any) {
    status.value = 'エラー: ' + e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section id="secInput">
    <h2>1. 応対方針の入力</h2>
    <label>通話方向（Step1）<select id="inDirection" v-model="form.call_direction"><option v-for="o in directionOptions()" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option></select></label>
    <p class="hint">Step1 で着信/架電を分け、Step2（以下の方針から生成する分岐スクリプト）で最初の発話への相手の返答ごとに分岐します。MVP は着信のみ。架電は実装予定です。</p>
    <label>応対目的・指示（必須）<textarea id="inInstruction" v-model="form.instruction" rows="4" maxlength="4000" /></label>
    <button id="btnSample" type="button" class="secondary" @click="form.instruction = config.sample_instruction">サンプル指示を入れる</button>
    <label>利用可能な事実・商品情報・FAQ（任意。ここに無い事実は発話させません）<textarea v-model="form.facts" rows="3" maxlength="8000" /></label>
    <label>禁止事項（任意。1行1項目）<textarea v-model="form.prohibitions" rows="2" maxlength="2000" /></label>
    <div class="fixedRules"><span>常に適用される固定ルール:</span><ul><li v-for="r in config.fixed_rules" :key="r">{{ r }}</li></ul></div>
    <label>最初の発話案（任意。未入力なら生成）<input v-model="form.first_utterance" maxlength="300"></label>
    <div class="row">
      <label>最大深さ <input v-model.number="form.max_depth" type="number" min="1" :max="config.limits.max_depth"></label>
      <label>最大ノード数（control含む）<input v-model.number="form.max_nodes" type="number" min="4" :max="config.limits.max_nodes"></label>
      <label>ノード当たり分岐数 <input v-model.number="form.max_branches" type="number" min="1" :max="config.limits.max_branches"></label>
    </div>
    <fieldset>
      <legend>音声設定（サーバー許可値のみ）</legend>
      <div class="row">
        <label>Provider <select v-model="voice.provider"><option v-for="p in config.voice_options.providers" :key="p" :value="p">{{ p }}</option></select></label>
        <label>モデル <select v-model="voice.model"><option v-for="m in config.voice_options.models" :key="m" :value="m">{{ m }}</option></select></label>
        <label>声 <select v-model="voice.voice"><option v-for="v in config.voice_options.voices" :key="v" :value="v">{{ v }}</option></select></label>
        <label>速度 <input v-model.number="voice.speed" type="number" step="0.05" :min="config.voice_options.speed.min" :max="config.voice_options.speed.max"></label>
        <label>発話スタイル <select v-model="voice.style_id"><option v-for="s in config.voice_options.styles" :key="s.id" :value="s.id">{{ s.id }}{{ s.text ? '：' + s.text.slice(0, 18) + '…' : '' }}</option></select></label>
      </div>
      <p class="hint">
        形式: {{ config.voice_options.format }}。音声生成（TTS）は分岐生成（Claude）とは別処理で、承認した版の発話文だけを音声化します。
        <span v-if="!config.voice_options.models.length">※TTS_MODEL/TTS_VOICE が未設定です。</span>
      </p>
    </fieldset>
    <button id="btnGenerate" type="button" :disabled="busy" @click="generate">分岐スクリプト生成</button>
    <div id="genStatus" class="status">{{ status }}</div>
  </section>
</template>
