# Node.js 22 LTS on Debian Bookworm. Ships with npm, git, zsh, and the
# non-root `node` user out of the box — everything we need to run Vite and
# the TypeScript build inside the container.
FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# Nothing else to install: the app is browser-only and has zero native deps.
# (USB access must happen in the browser on the host machine — see the
# README for the Web Serial workflow.)

# Improve npm feedback and cache location.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /workspaces/ppk-web
