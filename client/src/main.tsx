import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// Service worker: production only, and only where browsers allow it (HTTPS or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let notified = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install also claims the page; only an *update* deserves a toast.
    if (hadController && !notified) { notified = true; window.dispatchEvent(new Event('syncwave:update')); }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => { /* not fatal: app works without it */ });
  });
}
