import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import Swiper from 'swiper/bundle'
import 'swiper/css/bundle'
import '@fortawesome/fontawesome-free/css/all.min.css'
import './style.css'
import './assets/design-system.css'

window.Swiper = Swiper
createApp(App).use(createPinia()).mount('#app')
