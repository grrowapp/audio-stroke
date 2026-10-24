<script setup lang="ts">
defineProps<{ providers: any }>()
</script>

<template>
  <div class="badges">
    <span class="badge" :class="providers.scenario.mock ? 'mock' : 'real'">分岐生成: {{ providers.scenario.mock ? 'MOCK' : `Claude ${providers.scenario.model}` }}</span>
    <span class="badge" :class="providers.tts.mock ? 'mock' : 'real'">音声生成: {{ providers.tts.mock ? 'MOCK' : providers.tts.name }}</span>
    <span class="badge" :class="providers.realtime.mock ? 'mock' : 'real'">会話分類: {{ providers.realtime.mock ? 'MOCK' : `Realtime ${providers.realtime.model} / preview:${providers.realtime.preview_mode}` }}</span>
  </div>
</template>
