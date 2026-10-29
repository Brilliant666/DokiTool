<script setup>
import AppIcon from './AppIcon.vue'
import { computed } from 'vue'

const props = defineProps({ downloads: { type: Array, default: () => [] } })
const emit = defineEmits(['cancel', 'retry', 'handoff', 'clear-completed'])
const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return parseFloat((bytes / Math.pow(1024, index)).toFixed(2)) + ' ' + units[index]
}
const formatSpeed = (speed) => formatBytes(speed) + '/s'
const formatElapsed = (elapsed) => {
  const rawSeconds = Math.max(0, elapsed || 0)
  if (rawSeconds < 10) return `${rawSeconds.toFixed(1)} 秒`
  const seconds = Math.floor(rawSeconds)
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
const getStatusColor = (status) => ({ downloading: 'text-blue-500', completed: 'text-green-500', failed: 'text-red-500', cancelled: 'text-gray-500', 'handed-off': 'text-blue-500' }[status] || 'text-slate-500')
const getStatusIcon = (status) => ({ downloading: 'fa-spinner fa-spin', completed: 'fa-check-circle', failed: 'fa-exclamation-circle', cancelled: 'fa-times-circle', 'handed-off': 'fa-external-link-alt' }[status] || 'fa-hourglass-half')
const visibleDownloads = computed(() => props.downloads.filter(item => item.status !== 'completed' || item.show))
const activeCount = computed(() => props.downloads.filter(item => ['preparing', 'downloading'].includes(item.status)).length)
const allSettled = computed(() => props.downloads.length > 0 && activeCount.value === 0)
const allCompleted = computed(() => props.downloads.length > 0 && props.downloads.every(item => item.status === 'completed'))
const outcomeSummary = computed(() => [['completed', '完成'], ['failed', '失败'], ['cancelled', '取消'], ['handed-off', '浏览器处理']]
  .map(([status, label]) => [props.downloads.filter(item => item.status === status).length, label])
  .filter(([count]) => count > 0).map(([count, label]) => `${label} ${count}`).join(' · '))
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)]">
    <TransitionGroup name="slide-up">
      <div
        v-for="item in visibleDownloads"
        :key="item.id"
        class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-100 dark:border-slate-700 mb-3 overflow-hidden"
      >
        <div class="p-4">
          <div class="flex items-start justify-between mb-2">
            <div class="flex-1 min-w-0 mr-3">
              <div class="font-medium text-slate-800 dark:text-slate-200 truncate text-sm">
                {{ item.filename || '下载文件' }}
              </div>
              <div class="flex items-center gap-2 mt-1">
                <AppIcon :class="['fas', getStatusIcon(item.status), getStatusColor(item.status)]"></AppIcon>
                <span class="text-xs" :class="getStatusColor(item.status)">
                  {{ item.statusText || (item.status === 'downloading' ? '下载中...' : item.status) }}
                </span>
                <span v-if="item.progressKind === 'bytes' && item.status === 'downloading'" class="text-xs text-slate-400">
                  {{ formatSpeed(item.speed) }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                v-if="item.status === 'failed' || item.status === 'cancelled' || item.status === 'handed-off'"
                @click="emit('retry', item.id)"
                class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 hover:text-blue-500 transition-colors"
                title="重试"
              >
                <AppIcon class="fas fa-redo text-sm"></AppIcon>
              </button>

              <button
                v-if="item.status === 'downloading' || item.status === 'preparing'"
                @click="emit('cancel', item.id)"
                class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 hover:text-red-500 transition-colors"
                title="取消"
              >
                <AppIcon class="fas fa-times text-sm"></AppIcon>
              </button>

              <button
                v-if="item.status === 'completed' || item.status === 'cancelled' || item.status === 'failed' || item.status === 'handed-off'"
                @click="emit('clear-completed', item.id)"
                class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                title="清除"
              >
                <AppIcon class="fas fa-times text-sm"></AppIcon>
              </button>
            </div>
          </div>

          <div v-if="item.status === 'downloading'" class="mb-2">
            <div class="flex justify-between text-xs text-slate-500 mb-1">
              <span v-if="item.progressKind === 'bytes'">{{ formatBytes(item.loaded || 0) }}<template v-if="item.total"> / {{ formatBytes(item.total) }}</template><template v-else> / 大小未知</template></span>
              <span v-else>{{ item.progressKind === 'archive' ? '打包进度' : '分片进度' }}</span>
              <span v-if="item.progressKind !== 'bytes' || item.total">{{ item.percent || 0 }}%</span>
            </div>
            <div class="h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                class="h-full transition-all duration-300 rounded-full bg-blue-500"
                :style="{ width: (item.percent || 0) + '%' }"
              ></div>
            </div>
          </div>

          <div v-if="item.status === 'completed'" class="mb-2">
            <div class="h-2 bg-green-100 dark:bg-green-900/30 rounded-full overflow-hidden">
              <div
                class="h-full bg-green-500 rounded-full"
                style="width: 100%"
              ></div>
            </div>
          </div>

          <div v-if="item.elapsed !== undefined && item.status !== 'handed-off'" class="text-xs text-slate-500 mt-2"
            title="本次页面读取速度可能包含浏览器缓存，并非宽带测速">
            已用 {{ formatElapsed(item.elapsed) }}
            <template v-if="item.progressKind === 'bytes' && item.transferred"> · 平均 {{ formatSpeed(item.averageSpeed) }}（含等待）</template>
          </div>
          <div v-if="item.progressKind === 'bytes' && item.transferred > item.loaded" class="text-xs text-slate-400 mt-1">
            累计接收 {{ formatBytes(item.transferred) }}，含重试线路
          </div>
          <div v-if="item.status === 'handed-off'" class="text-xs text-slate-500 mt-2">
            请在浏览器下载列表确认进度和结果，本站无法追踪。
          </div>
          <button v-if="item.nativeAvailable && ['downloading', 'failed'].includes(item.status)"
            @click="emit('handoff', item.id)"
            class="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            title="打开源文件，由浏览器处理；本站不再显示该次下载速度">
            {{ item.status === 'downloading' ? '改用浏览器下载' : '交给浏览器下载' }}
          </button>
          <div v-if="item.status === 'failed' && item.error" class="text-xs text-red-500 mt-1">
            {{ item.error }}
          </div>
        </div>
      </div>
    </TransitionGroup>

    <div
      v-if="visibleDownloads.length > 0"
      class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-100 dark:border-slate-700 px-4 py-2 flex items-center justify-between gap-2"
    >
      <div class="text-sm text-slate-600 dark:text-slate-400">
        <span v-if="activeCount">
          <AppIcon class="fas fa-cloud-download-alt mr-1"></AppIcon>
          {{ activeCount }} 个进行中
        </span>
        <span v-else-if="allCompleted">
          <AppIcon class="fas fa-check-circle text-green-500 mr-1"></AppIcon>
          全部完成
        </span>
        <span v-else>{{ outcomeSummary }}</span>
      </div>

      <button
        v-if="allSettled"
        @click="emit('clear-completed', 'all')"
        class="text-xs shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
      >
        清除全部
      </button>
    </div>
  </div>
</template>

<style scoped>
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.slide-up-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
