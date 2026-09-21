# LOGOS — container image
# ============================================================================
# Node 22.6+ is required: it is the first release with native TypeScript type
# stripping, which is how this project runs .ts files with no build step.
#
# There are no dependencies to install, so this image is almost entirely the
# runtime plus the source. That is the point of the zero-dependency rule: the
# container is small, builds in seconds, and has no supply chain to audit
# beyond Node itself.

FROM node:24-alpine

LABEL org.opencontainers.image.title="LOGOS cognitive kernel"
LABEL org.opencontainers.image.description="A zero-dependency cognitive kernel for AGI research"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/yourname/logos-cognitive-kernel"

WORKDIR /logos

# Copy manifests first so the layer cache survives source edits.
COPY package.json ./

# `--include=dev` because config in some images sets omit=dev, and the type
# check needs the compiler. If you only want to RUN the kernel — which is all
# the demo and CLI need — you may skip this entirely; the code has no runtime
# dependencies at all.
RUN npm install --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
COPY test ./test
COPY docs ./docs
COPY README.md LICENSE ./

# Run as the unprivileged user the Node image already provides. A cognitive
# kernel has no need for root, and granting it "just in case" is how images end
# up with unnecessary privilege.
USER node

ENV NODE_ENV=production
ENV LOGOS_SEED=0x5eed

# Default to the worked scenario; override with any CLI command, e.g.
#   docker run --rm logos inspect
#   docker run --rm logos bench --cycles 500
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["demo"]
