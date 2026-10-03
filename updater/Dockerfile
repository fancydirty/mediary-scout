# Mediary Scout updater — the only container with Docker access.
# DOCKER_MIRROR is the same registry prefix as the web image (see the root Dockerfile).
ARG DOCKER_MIRROR
FROM ${DOCKER_MIRROR:+${DOCKER_MIRROR}/library/}docker:27-cli
RUN apk add --no-cache git nodejs su-exec
WORKDIR /updater
COPY server.mjs run-update.sh tunnel-env.mjs ./
RUN chmod +x run-update.sh && git config --system --add safe.directory /repo
# Exec-form ENTRYPOINT, not CMD: the base image's docker-entrypoint.sh prepends
# `docker` to any command that is a docker subcommand, and `node` is one (`docker node`).
ENTRYPOINT ["node", "server.mjs"]
