# LOGOS — container image
# ============================================================================
# Node 22.18+ is required: it is the first release with native TypeScript type
# stripping, which is how this project runs .ts files with no build step.
#
# THE IMAGE IS DELIBERATELY MINIMAL. It installs nothing at run time, because
# there is nothing to install: the kernel has zero runtime dependencies, so what
# ships is the Node runtime plus the source. The container is small, builds in
# seconds, and has no supply chain to audit beyond Node itself.
#
# CI builds this image and runs the demo inside it, because a Dockerfile nothing
# verifies is a Dockerfile that stops working the first time someone changes a
# path.

FROM node:24-alpine

LABEL org.opencontainers.image.title="LOGOS cognitive kernel"
LABEL org.opencontainers.image.description="A zero-dependency cognitive kernel for AGI research"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/CP-violation618/logos-cognitive-kernel"

WORKDIR /logos

# Source only. No `npm install`, because there is nothing to install at run time
# — the dev dependencies (a type checker and Node's type definitions) are used
# to VERIFY the source, not to execute it, and an image that runs the kernel
# does not need either. Copying them in would add a compiler and a package tree
# for no benefit, and would make the image's contents a lie about what the
# project depends on.
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
COPY test ./test
COPY docs ./docs
COPY README.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md ./

# Run as the unprivileged user the Node image already provides. A cognitive
# kernel has no need for root, and granting it "just in case" is how images end
# up with unnecessary privilege. Ownership is handed over because the default is
# root-owned and the node user must at least be able to read its own source.
RUN chown -R node:node /logos

USER node

ENV NODE_ENV=production
ENV LOGOS_SEED=0x5eed

# Default to the worked scenario; override with any CLI command, e.g.
#   docker run --rm logos inspect
#   docker run --rm logos bench --cycles 500
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["demo"]
