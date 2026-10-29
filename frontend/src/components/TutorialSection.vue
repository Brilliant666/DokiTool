<script setup>
defineProps({
  locale: String
})

const content = {
  'zh-CN': {
    badge: '三步搞定',
    title: '使用教程',
    steps: [
      { title: '复制视频链接', body: '在抖音、快手等平台打开作品，通过分享复制链接。', icon: 'fa-copy' },
      { title: '粘贴并解析', body: '回到本页，将链接粘贴到输入框，可选对应平台接口。', icon: 'fa-paste' },
      { title: '下载保存', body: '点击「开始解析」，完成后下载无水印视频或图集。', icon: 'fa-download' }
    ]
  },
  'en': {
    badge: '3 Steps',
    title: 'How to Use',
    steps: [
      { title: 'Copy Video Link', body: 'Open the video in Douyin, Kuaishou, etc. Copy the share link.', icon: 'fa-copy' },
      { title: 'Paste & Parse', body: 'Come back, paste the link, optionally select a platform.', icon: 'fa-paste' },
      { title: 'Download', body: 'Click "Start Parsing", then download the watermark-free video or album.', icon: 'fa-download' }
    ]
  }
}

const getContent = (locale) => content[locale] || content['zh-CN']

const iconPaths = {
  'fa-copy': 'M9 9h11v12H9z M15 9V3H4v12h5',
  'fa-paste': 'M9 5H5v16h14V5h-4 M9 3h6v4H9z M8 12h8 M8 16h6',
  'fa-download': 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
}
</script>

<template>
  <section id="course" class="mb-16 scroll-mt-16 sm:scroll-mt-18">
    <div class="text-center mb-10">
      <span class="inline-block px-3 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 text-sm mb-4">
        {{ getContent(locale).badge }}
      </span>
      <h3 class="text-3xl font-bold">{{ getContent(locale).title }}</h3>
    </div>

    <div class="grid md:grid-cols-3 gap-6">
      <div v-for="step in getContent(locale).steps" :key="step.title" 
           class="bg-white dark:bg-slate-800 rounded-2xl p-6 text-center hover:shadow-xl transition-all">
        <div class="tutorial-step-icon w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path :d="iconPaths[step.icon]" />
          </svg>
        </div>
        <h4 class="font-semibold mb-2">{{ step.title }}</h4>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ step.body }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tutorial-step-icon {
  color: #fff;
  background-color: #4f46e5;
  background-image: linear-gradient(135deg, #6366f1, #a855f7);
}

@media (forced-colors: active) {
  .tutorial-step-icon {
    color: CanvasText;
    background: Canvas;
    border: 1px solid CanvasText;
  }
}
</style>
