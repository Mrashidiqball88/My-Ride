#!/bin/bash
set -e

# Install pnpm workspace dependencies (api-server, mockup-sandbox, libs, etc.)
pnpm install

# Install ride-hailing npm dependencies (not part of the pnpm workspace)
cd ride-hailing && npm install --prefer-offline
