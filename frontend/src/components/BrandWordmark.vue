<script setup>
import { ref, onMounted } from 'vue'
import wordmarkUrl from '../assets/brand/dokitool-wordmark.png'

const image = ref(null)
const failed = ref(false)
const checkImage = () => {
  const element = image.value
  if (element?.complete && !element.naturalWidth) failed.value = true
}
onMounted(checkImage)
</script>

<template>
  <span class="relative inline-block w-20 h-8 shrink-0">
    <span v-if="failed" class="absolute inset-0 flex items-center justify-center font-bold text-lg bg-gradient-to-r from-indigo-600 to-sky-500 bg-clip-text text-transparent">DokiTool</span>
    <img v-else ref="image" :src="wordmarkUrl" alt="DokiTool" class="w-20 h-8 object-contain" width="80" height="32" decoding="async" @error="failed = true" />
  </span>
</template>
