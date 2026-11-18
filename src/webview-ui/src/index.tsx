import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DraftQueuePage from './DraftQueuePage';

// One bundle serves every surface; the host picks the root component through
// `data-mode` on the mount point (see src/webview/webviewHtml.ts). Absent or
// unknown modes fall back to the chat app so a stale HTML file still renders.
const root = document.getElementById('root')!;
const mode = root.dataset.mode;

createRoot(root).render(
  mode === 'draftQueue' ? <DraftQueuePage /> : <App />,
);
