# Table Games — one process serving both the pages and the socket.
#
# Deliberately NOT Next's `output: "standalone"` trace. That prunes
# node_modules down to what a Next server needs, and this app's server is
# `server.ts`, which Next knows nothing about — the trace would drop `ws`,
# `tsx` and half the game engine, and the failure would be at runtime.
#
# Two stages: a build stage that keeps devDependencies (Next needs
# TypeScript and the Tailwind toolchain to build), and a runtime stage
# with production dependencies only. `tsx` and `cross-env` are among
# those on purpose — the server is TypeScript that is never compiled, so
# they are as much a runtime dependency as `ws` is.

# ---- deps: production-only, cached separately from the build ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- build: needs the dev toolchain ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- run ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next writes nothing at runtime here, so an unprivileged user is free.
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src

USER app
# Platforms inject their own PORT; 3000 is only the default.
ENV PORT=3000
EXPOSE 3000

# `server.listen(port)` passes no host, so Node binds every interface —
# which is what a container needs. Nothing here should set HOSTNAME to
# localhost.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
