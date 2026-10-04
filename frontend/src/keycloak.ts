import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
  url: 'http://localhost:8180',
  realm: 'soc',
  clientId: 'soc-portal',
});