FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# The build reads PUBLIC_ABS_ORIGIN through $env/static/public and fails
# without it, and .dockerignore keeps .env files out of the image on purpose.
# The value is inert in this image: it only backs the SvelteKit dev proxy,
# whereas the deployed container is static files with Caddy proxying /abs/*
# to ABS_ORIGIN. Set that at run time, not here.
ENV PUBLIC_ABS_ORIGIN=http://localhost:13378
RUN npm run build

FROM caddy:2-alpine
COPY --from=builder /app/build /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
