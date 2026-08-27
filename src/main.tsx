import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import { RendererBoundary } from '@/components/RendererBoundary'
import { installCrashEvidence } from '@/lib/crash'
import { behaveLikeAWindow } from '@/lib/native'
import { installPreloadRecovery } from '@/lib/renderer-recovery'
import '@/styles/app.css'

// Before the first render, so no frame of this window ever behaves like a tab.
behaveLikeAWindow()
installCrashEvidence()
installPreloadRecovery()

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing its #root element')

createRoot(container).render(
  <StrictMode>
    <RendererBoundary>
      <App />
    </RendererBoundary>
  </StrictMode>,
)
