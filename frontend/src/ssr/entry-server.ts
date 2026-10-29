// Executed at build time only; production continues to serve static files.
import { renderToString } from 'vue/server-renderer'
import { createHomeApp } from './createHomeApp'

export async function renderHome() {
  return renderToString(createHomeApp({
    prerendered: true,
    locale: 'zh-CN',
    isDark: false,
    inputUrl: '',
  }))
}
