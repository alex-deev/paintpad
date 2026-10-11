FROM docker.io/library/node:24.18

RUN npm install -g npm@latest

# Switch back to the non-root user for development safety
USER node

# Install Opencode (rootless)
RUN curl -fsSL https://opencode.ai/v2/install | bash
