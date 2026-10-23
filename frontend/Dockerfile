FROM node:22-slim AS build

WORKDIR /app

ARG VITE_APP_VERSION
ENV VITE_APP_VERSION=$VITE_APP_VERSION

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npm run build

# Serve with nginx
FROM nginxinc/nginx-unprivileged:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY default.conf.template /etc/nginx/templates/default.conf.template

# Largest request body nginx accepts. It covers the largest default backend
# upload limit, 25 MB for agents knowledge files. Override it with the
# NGINX_CLIENT_MAX_BODY_SIZE environment variable.
ENV NGINX_CLIENT_MAX_BODY_SIZE=25m

# Have the image derive the DNS resolver from /etc/resolv.conf, so the same
# image proxies to the backend on Docker, Podman, Kubernetes and Railway with
# no per-platform configuration. 19-resolver.envsh turns that into
# NGINX_RESOLVER (with a Docker fallback) for the config template; setting
# NGINX_RESOLVER explicitly still overrides both.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY --chmod=755 docker-entrypoint.d/19-resolver.envsh /docker-entrypoint.d/

EXPOSE 8080
