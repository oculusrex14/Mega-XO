# Override NODE_IMAGE with a vetted digest for a reproducible release rebuild.
# The deployed application image itself is always selected by immutable digest.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux restic \
    && rm -rf /var/lib/apt/lists/*
ARG MEGA_RELEASE=local
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=1024 UV_THREADPOOL_SIZE=4 MEGA_RELEASE=${MEGA_RELEASE}
LABEL org.opencontainers.image.source="https://github.com/oculusrex14/Mega-XO" org.opencontainers.image.revision=${MEGA_RELEASE}
WORKDIR /app
COPY --chown=node:node package.json index.html ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node deploy/ ./deploy/
COPY --chown=node:node scripts/ ./scripts/
USER node
EXPOSE 8080 9091
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/livez',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "deploy/run.sh"]
