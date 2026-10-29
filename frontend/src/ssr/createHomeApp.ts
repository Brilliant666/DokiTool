import { createApp, createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import App from '../App.vue'
import { homeInitialStateKey, type HomeInitialState } from './initialState'

export function createHomeApp(initialState: HomeInitialState) {
  const app = (initialState.prerendered ? createSSRApp : createApp)(App)
  app.use(createPinia())
  app.provide(homeInitialStateKey, initialState)
  return app
}
