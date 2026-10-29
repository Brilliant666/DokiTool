<script setup>
import AppIcon from './AppIcon.vue'
import { platformTabs } from '../utils/platforms'
defineProps({
  currentPlatform: String,
  locale: String
})

const emit = defineEmits(['select'])

const getPlatforms = (locale) => platformTabs(locale)
</script>

<template>
  <section class="mb-12">
    <div class="flex flex-wrap justify-center gap-2">
      <button
        v-for="tab in getPlatforms(locale)"
        :key="tab.key"
        @click="emit('select', tab.key)"
        :class="[
          'px-4 py-2 rounded-lg font-medium text-sm transition-all flex items-center gap-2',
          currentPlatform === tab.key
            ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-lg'
            : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700'
        ]"
      >
        <AppIcon :class="['fas', tab.icon]" :style="tab.iconColor ? { color: tab.iconColor } : {}"></AppIcon>
        <span>{{ tab.label }}</span>
      </button>
    </div>
  </section>
</template>
