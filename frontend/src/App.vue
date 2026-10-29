<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useVideoStore } from './stores/video'
import HeaderNav from './components/HeaderNav.vue'
import HeroSection from './components/HeroSection.vue'
import ResultSection from './components/ResultSection.vue'
import PlatformGrid from './components/PlatformGrid.vue'
import TutorialSection from './components/TutorialSection.vue'
import FaqSection from './components/FaqSection.vue'
import FooterSection from './components/FooterSection.vue'
import ToastContainer from './components/ToastContainer.vue'
import ProgressModal from './components/ProgressModal.vue'
import ParticlesCanvas from './components/ParticlesCanvas.vue'
import DownloadCard from './components/DownloadCard.vue'
import { useVideoParser } from './composables/useVideoParser'
import { useMediaDownload } from './composables/useMediaDownload'
import { useVideoSelection } from './composables/useVideoSelection'
import { selectMediaSource } from './utils/mediaSource'

const videoStore = useVideoStore()
const isDark = ref(false)

const isDownloading = computed(() =>
  videoStore.downloads.some((task) =>
    ['preparing', 'downloading'].includes(task.status)
  )
)
const showBackup = ref(false)
const locale = ref(localStorage.getItem('lang') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'))
const currentVideoUrl = ref('')
const { inputUrl, parseError, currentPlatform, parseButton, parseVideo, selectPlatform, resolveBilibiliPage } = useVideoParser({
  videoStore,
  locale,
  showBackup,
  currentVideoUrl,
  showToast: (message, type, duration) => videoStore.addToast(message, type, duration)
})

const selection = useVideoSelection({ videoStore })

// 解析成功后同步选集状态：重置并定位入口命中的分集/合集
watch(
  () => videoStore.resultData,
  (data, previous) => {
    // A lazy-resolution patch creates a new result object. Keep the user's
    // selection during those patches; only a newly parsed source resets it.
    if (!data || !previous || data._sourceUrl !== previous._sourceUrl) selection.syncResult()
  }
)

const showToast = (message, type = 'success', duration = 3000) => {
  videoStore.addToast(message, type, duration)
}

// B 站懒解析（多 P / 合集分集）：封装解析器的 resolveBilibiliVideo，供下载/选集复用
const resolveVideoUrl = async (video, signal) => {
  const resolved = await resolveBilibiliPage(video, signal)
  if (!resolved) return null
  return { ...resolved, video_backup: resolved.video_backup ?? [] }
}

const {
  downloadFile,
  downloadMainVideo,
  downloadVideoByIndex,
  downloadSelected,
  downloadAllVideos,
  downloadVideosAsZip,
  downloadAllMedia,
  downloadBackupVideo,
  downloadMusic,
  downloadLiveVideo,
  downloadLiveCover,
  downloadImage,
  handleCancelDownload,
  handleRetryDownload,
  handleBrowserDownload,
  handleClearCompleted
} = useMediaDownload({
  videoStore,
  currentVideoUrl,
  showToast,
  selection,
  resolveVideoUrl
})

// 选中某集时：若该 P/合集分集尚未解析（B 站多 P 或合集），自动懒解析回填真链，刷新播放器
watch(
  () => selection.currentVideo.value,
  async (video) => {
    if ((video?._cid || video?._bvid) && !video.url && !video._resolving && !video.error && resolveVideoUrl) {
      const resultVersion = videoStore.resultVersion
      videoStore.patchVideo(video, { _resolving: true })
      const resolved = await resolveVideoUrl(video)
      if (videoStore.resultVersion !== resultVersion) return
      if (resolved?.url) {
        videoStore.patchVideo(video, {
          ...resolved,
          _resolved: true,
          _resolving: false,
        })
      } else {
        videoStore.patchVideo(video, {
          _resolving: false,
          error: '解析失败，暂不支持下载',
        })
      }
    }
  }
)

const copyUrl = async (url) => {
  if (!url) {
    showToast('复制失败', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(String(url))
    showToast('已复制到剪贴板')
  } catch (e) {
    showToast('复制失败', 'error')
  }
}

const downloadAll = () => downloadAllMedia('all')
const downloadAllImages = () => downloadAllMedia('images')
const downloadAllLivePhotos = () => downloadAllMedia('live')
const downloadAllLiveCovers = () => downloadAllMedia('covers')

const switchVideo = (backup) => {
  if (backup?.url) {
    currentVideoUrl.value = backup.url
    const data = videoStore.resultData
    if ((data?.videos?.length > 1 || data?.collections?.length) && selection.currentVideo.value) {
      videoStore.patchVideo(selection.currentVideo.value, selectMediaSource(selection.currentVideo.value, backup))
    }
  }
}

const formatNumber = (num) => {
  if (!num && num !== 0) return '0'
  const n = Number(num)
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}

const formatDuration = (seconds) => {
  const duration = Number(seconds)
  if (!Number.isFinite(duration) || duration <= 0) return '0:00'
  const tenths = Math.round(duration * 10)
  const m = Math.floor(tenths / 600)
  const s = Math.floor((tenths % 600) / 10)
  const fraction = tenths % 10
  return `${m}:${String(s).padStart(2, '0')}${fraction ? `.${fraction}` : ''}`
}

const toggleTheme = () => {
  isDark.value = !isDark.value
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
  document.documentElement.classList.toggle('dark', isDark.value)
}

const setLocale = (lang) => {
  locale.value = lang
  localStorage.setItem('lang', lang)
  document.documentElement.lang = lang
}

onMounted(() => {
  const savedTheme = localStorage.getItem('theme')
  if (savedTheme) {
    isDark.value = savedTheme === 'dark'
  } else {
    isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  document.documentElement.classList.toggle('dark', isDark.value)
  document.documentElement.lang = locale.value
})
</script>

<template>
  <div class="min-h-screen">
    <ParticlesCanvas />
    <ToastContainer />
    <ProgressModal />
    <DownloadCard
      :downloads="videoStore.downloads"
      @cancel="handleCancelDownload"
      @retry="handleRetryDownload"
      @handoff="handleBrowserDownload"
      @clear-completed="handleClearCompleted"
    />

    <HeaderNav
      :is-dark="isDark"
      :locale="locale"
      @toggle-theme="toggleTheme"
      @set-locale="setLocale"
    />

    <main class="max-w-7xl mx-auto px-4 pb-8 pt-0 relative z-10">
      <HeroSection
        v-model:input-url="inputUrl"
        :is-loading="parseButton.isLoading.value"
        :is-error="!!parseError || parseButton.state.value === 'error'"
        :parse-error="parseError"
        :locale="locale"
        :current-platform="currentPlatform"
        @parse="parseVideo"
        @select-platform="selectPlatform"
      />

      <ResultSection
        :result-data="videoStore.resultData"
        :result-version="videoStore.resultVersion"
        :is-downloading="isDownloading"
        :show-backup="showBackup"
        :locale="locale"
        :selection="selection"
        :format-number="formatNumber"
        :format-duration="formatDuration"
        :current-video-url="currentVideoUrl"
        @download-main="downloadMainVideo"
        @download-backup="downloadBackupVideo"
        @download-all="downloadAll"
        @download-images="downloadAllImages"
        @download-image="downloadImage"
        @download-music="downloadMusic"
        @download-live-video="downloadLiveVideo"
        @download-live-cover="downloadLiveCover"
        @download-all-live="downloadAllLivePhotos"
        @download-all-live-covers="downloadAllLiveCovers"
        @copy-url="copyUrl"
        @toggle-backup="showBackup = !showBackup"
        @switch-video="switchVideo"
        @select-video="selection.selectIndex"
        @toggle-video="selection.toggleSelect"
        @select-all-videos="selection.selectAll"
        @clear-selection="selection.clearSelection"
        @select-collection="selection.setSection"
        @download-index="downloadVideoByIndex"
        @download-selected="downloadSelected"
        @download-all-videos="downloadAllVideos"
        @download-selected-zip="(videos) => downloadVideosAsZip(videos, undefined)"
        @download-all-zip="(videos) => downloadVideosAsZip(videos, undefined)"
      />

      <PlatformGrid :locale="locale" />
      <TutorialSection :locale="locale" />
      <FaqSection :locale="locale" />
    </main>

    <FooterSection :locale="locale" />
  </div>
</template>
