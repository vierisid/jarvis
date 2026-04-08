# ─── J.A.R.V.I.S. Docker Image ──────────────────────────────────────
#
# Multi-stage build for the JARVIS daemon.
# Uses Debian-based Bun images (not Alpine) for sharp glibc compatibility.
# Supports multi-arch builds: linux/amd64, linux/arm64, and more.
#
# Build:   docker build -t jarvis .
# Build with version: docker build --build-arg VERSION=0.3.1 -t jarvis .
# Build multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -t jarvis .
# Run:     docker run -p 3142:3142 -v jarvis-data:/data -e JARVIS_API_KEY=sk-... jarvis
#
# ─────────────────────────────────────────────────────────────────────

# Global build args
ARG VERSION
ARG TARGETPLATFORM

# ─── Stage 1: Install dependencies ─────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy only dependency manifests for layer caching
COPY package.json bun.lock ./

# Install all dependencies (includes devDependencies needed for UI build)
# Note: Platform-specific dependencies (@usejarvis/sidecar-*) are handled via optionalDependencies
# and will be selected based on the target platform (buildx handles this automatically).
# Use --frozen-lockfile to ensure reproducible builds across platforms.
RUN set -e; \
    bun install --frozen-lockfile && \
    bun pm cache clean

# ─── Stage 2: Build UI and copy models ─────────────────────────────
FROM deps AS build

WORKDIR /app

# Copy source files needed for the build
COPY src/ src/
COPY ui/ ui/
COPY bin/ bin/
COPY roles/ roles/
COPY scripts/ scripts/
COPY tsconfig.json ./

# Stamp release version into package.json if provided
ARG VERSION
RUN if [ -n "$VERSION" ]; then \
      bunx npm version "$VERSION" --no-git-tag-version --allow-same-version; \
    fi

# Prepare and validate ONNX models and WASM runtime
# Create directories and copy assets with error handling
RUN set -e; \
    mkdir -p ui/public/openwakeword/models ui/public/ort && \
    cp -v node_modules/openwakeword-wasm-browser/models/melspectrogram.onnx \
       node_modules/openwakeword-wasm-browser/models/embedding_model.onnx \
       node_modules/openwakeword-wasm-browser/models/silero_vad.onnx \
       node_modules/openwakeword-wasm-browser/models/hey_jarvis_v0.1.onnx \
       ui/public/openwakeword/models/ && \
    cp -v node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs \
       ui/public/ort/

# Build the dashboard UI bundle
# Bail on error (-e already set above)
RUN bun build ui/index.html --outdir ui/dist

# ─── Stage 3: Production image ─────────────────────────────────────
FROM oven/bun:1-slim AS production

# Declare TARGETPLATFORM for visibility (buildx will set this)
ARG TARGETPLATFORM

# Install runtime dependencies (minimal for security)
# ca-certificates: HTTPS calls to LLM APIs
# git: required by the Site Builder for project version control  
# procps: for debugging and health checks
# Set debconf to non-interactive mode for cleaner builds
RUN set -e; \
    DEBIAN_FRONTEND=noninteractive; \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      make \
      procps \
      libc-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

# Copy installed dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source and built assets from build stage
# Use --chown to avoid needing separate chown commands, reducing layers
COPY --from=build --chown=jarvis:jarvis /app/src ./src
COPY --from=build --chown=jarvis:jarvis /app/bin ./bin
COPY --from=build --chown=jarvis:jarvis /app/roles ./roles
COPY --from=build --chown=jarvis:jarvis /app/ui/dist ./ui/dist
COPY --from=build --chown=jarvis:jarvis /app/ui/public ./ui/public

# Copy version-stamped package.json from build stage (not the original)
COPY --from=build --chown=jarvis:jarvis /app/package.json ./
COPY tsconfig.json ./

# Install jarvis as a global command
# Note: `bun link` can't be used here — it symlinks through /root/.bun/ which
# is inaccessible to the non-root jarvis user. Direct symlink works because
# Bun resolves import.meta.dir through symlinks to the real path (/app/bin).
# Fix line endings from Windows (CRLF) to Unix (LF) for the shebang to work
RUN set -e; \
    sed -i 's/\r$//' /app/bin/jarvis.ts && \
    chmod +x /app/bin/jarvis.ts && \
    ln -s /app/bin/jarvis.ts /usr/local/bin/jarvis

# Create non-root user and data directory (before chown to ensure permissions)
# Use system user IDs for better compatibility across platforms
RUN set -e; \
    groupadd -r -g 999 jarvis && \
    useradd -r -u 999 -g jarvis -d /data -s /sbin/nologin jarvis && \
    mkdir -p /data && \
    chown -R jarvis:jarvis /data /app

# Set environment variables for production runtime
ENV JARVIS_HOME=/data \
    NODE_ENV=production \
    JARVIS_LOG_LEVEL=info

# Security: Drop unnecessary capabilities, run with read-only root when possible
# (can be overridden with --read-only=false at runtime if needed)

EXPOSE 3142
VOLUME ["/data"]

# Health check using shell exit code (more reliable cross-platform than exec)
# Checks if jarvis daemon is responding to health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD bun -e "try { const r = await fetch('http://localhost:3142/api/health', {timeout: 5000}); process.exit(r.ok ? 0 : 1); } catch(e) { process.exit(1); }" || exit 1

# Switch to non-root user for security
USER jarvis

ENTRYPOINT ["jarvis"]
CMD ["start", "--no-open", "--data-dir", "/data", "--no-local-tools"]
