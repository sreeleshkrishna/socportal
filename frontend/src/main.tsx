import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import App from './App';
import { keycloak } from './keycloak';

// follow the system theme until the user picks one
const saved = localStorage.getItem('theme');
const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark ? 'dark' : 'light';

const root = document.getElementById('root')!;

keycloak
  .init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })
  .then((authenticated) => {
    if (authenticated) createRoot(root).render(<App />);
  })
  .catch((e) => {
    console.error('Keycloak init failed', e);
    root.textContent = 'Sign-in is unavailable. Try again in a moment.';
  });