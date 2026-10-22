FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_API_URL=same-origin
ARG VITE_KEYCLOAK_URL=https://localhost:8443
ARG VITE_KEYCLOAK_REALM=soc
ARG VITE_KEYCLOAK_CLIENT=soc-portal
ENV VITE_API_URL=$VITE_API_URL \
    VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL \
    VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM \
    VITE_KEYCLOAK_CLIENT=$VITE_KEYCLOAK_CLIENT
RUN npm run build

FROM nginx:stable-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY gateway/nginx.conf /etc/nginx/conf.d/portal.conf
COPY --from=web /web/dist /usr/share/nginx/html