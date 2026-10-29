<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const canvasRef = ref(null)
let dispose = () => {}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let lastFrame = null
  let disposed = false
  const particles = []

  const resize = () => {
    const previousWidth = canvas.width
    const previousHeight = canvas.height
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    particles.forEach(p => {
      if (previousWidth) p.x *= canvas.width / previousWidth
      if (previousHeight) p.y *= canvas.height / previousHeight
    })
    paint(0)
  }
  
  const createParticle = () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5,
    size: Math.random() * 2 + 1,
    opacity: Math.random() * 0.5 + 0.1
  })
  
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  for (let i = 0; i < 50; i++) {
    particles.push(createParticle())
  }
  
  // Keep the existing 50 dots, palette and size. Velocity is measured against
  // the original 60 Hz rendering so faster displays do not speed up the effect.
  const paint = (step) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    particles.forEach(p => {
      p.x += p.vx * step
      p.y += p.vy * step
      if (p.x < 0 || p.x > canvas.width) {
        p.vx *= -1
        p.x = Math.max(0, Math.min(canvas.width, p.x))
      }
      if (p.y < 0 || p.y > canvas.height) {
        p.vy *= -1
        p.y = Math.max(0, Math.min(canvas.height, p.y))
      }
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(99, 102, 241, ${p.opacity})`
      ctx.fill()
    })
  }

  const canAnimate = () => !disposed && !document.hidden && !motion.matches
  const stop = () => {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    lastFrame = null
  }
  const tick = (time) => {
    frame = 0
    if (!canAnimate()) return
    // A delayed frame or tab resume must not make particles jump across the page.
    const step = lastFrame === null ? 0 : Math.min(50, Math.max(0, time - lastFrame)) / (1000 / 60)
    lastFrame = time
    paint(step)
    frame = window.requestAnimationFrame(tick)
  }
  const start = () => {
    if (!canAnimate() || frame) return
    lastFrame = null
    // The static dots are already visible; let the first content paint happen
    // before starting the continuous decoration loop.
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (canAnimate()) frame = window.requestAnimationFrame(tick)
    })
  }
  const updateActivity = () => {
    if (canAnimate()) start()
    else stop()
  }

  paint(0)
  start()
  window.addEventListener('resize', resize, { passive: true })
  document.addEventListener('visibilitychange', updateActivity)
  if (motion.addEventListener) motion.addEventListener('change', updateActivity)
  else motion.addListener(updateActivity)
  dispose = () => {
    disposed = true
    stop()
    window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', updateActivity)
    if (motion.removeEventListener) motion.removeEventListener('change', updateActivity)
    else motion.removeListener(updateActivity)
  }
})

onUnmounted(() => dispose())
</script>

<template>
  <canvas ref="canvasRef" class="particle-canvas"></canvas>
</template>
