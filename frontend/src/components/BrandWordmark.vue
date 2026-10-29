<script setup>
import { ref, onMounted } from 'vue'
import wordmarkUrl from '../assets/brand/dokitool-wordmark.png'

const image = ref(null)
const ready = ref(false)
const reveal = async () => {
  const element = image.value
  if (!element?.complete || !element.naturalWidth) return
  try {
    if (element.decode) await element.decode()
    if (image.value === element && element.naturalWidth) ready.value = true
  } catch {
    // Keep the readable brand in place when decoding fails.
  }
}
onMounted(reveal)
</script>

<template>
  <span class="relative inline-block w-20 h-8 shrink-0">
    <span v-if="!ready" aria-hidden="true" class="absolute inset-0 flex items-center justify-center font-bold text-lg bg-gradient-to-r from-indigo-600 to-sky-500 bg-clip-text text-transparent">DokiTool</span>
    <img ref="image" :src="wordmarkUrl" alt="DokiTool" class="w-20 h-8 object-contain" :class="{ 'opacity-0': !ready }" width="80" height="32" decoding="async" @load="reveal" />
  </span>
</template>
