import { createHomeApp } from './ssr/createHomeApp'
import { getClientInitialState } from './ssr/initialState'
import './style.css'
import './assets/design-system.css'

const root = document.getElementById('app')
if (!root) throw new Error('Missing application root')
createHomeApp(getClientInitialState(root)).mount(root)
