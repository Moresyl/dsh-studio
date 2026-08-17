import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import { behaveLikeAWindow } from '@/lib/native'
import '@/styles/app.css'

// Before the first render, so no frame of this window ever behaves like a tab.
behaveLikeAWindow()

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing its #root element')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
