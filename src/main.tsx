import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import '@/styles/app.css'

// A webview is not a browser. Dropping a file must not navigate the app away,
// and the browser context menu offers nothing a desktop app wants — except over
// text that was deliberately made selectable.
window.addEventListener('contextmenu', (event) => {
  const target = event.target
  if (target instanceof Element && target.closest('.selectable')) return
  event.preventDefault()
})
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing its #root element')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
