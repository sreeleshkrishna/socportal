import { createRoot } from 'react-dom/client';
import App from './App';
import { keycloak } from './keycloak';

keycloak
  .init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })
  .then((authenticated) => {
    if (authenticated) createRoot(document.getElementById('root')!).render(<App />);
  })
  .catch((e) => console.error('Keycloak init failed', e));