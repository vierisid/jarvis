# ─── J.A.R.V.I.S. Docker Image ──────────────────────────────────────
#
# Multi-stage build for the JARVIS daemon.
# Uses Debian-based Bun images (not Alpine) for sharp glibc compatibility.
#
# Build:   docker build -t jarvis .
# Run:     docker run -p 3142:3142 -v jarvis-data:/data -e JARVIS_API_KEY=sk-... jarvis
#
# ─────────────────────────────────────────────────────────────────────

# ─── Stage 1: Install dependencies ─────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy only dependency manifests for layer caching
COPY package.json bun.lock ./

# Install all dependencies (includes devDependencies needed for UI build)
RUN bun install --frozen-lockfile

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

# Copy ONNX wake-word models and WASM runtime from node_modules into ui/public/
RUN mkdir -p ui/public/openwakeword/models ui/public/ort && \
    cp node_modules/openwakeword-wasm-browser/models/melspectrogram.onnx \
       node_modules/openwakeword-wasm-browser/models/embedding_model.onnx \
       node_modules/openwakeword-wasm-browser/models/silero_vad.onnx \
       node_modules/openwakeword-wasm-browser/models/hey_jarvis_v0.1.onnx \
       ui/public/openwakeword/models/ && \
    cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs \
       ui/public/ort/

# Build the dashboard UI bundle
RUN bun build ui/index.html --outdir ui/dist

# ─── Stage 3: Production image ─────────────────────────────────────
FROM oven/bun:1-slim AS production

# ca-certificates: HTTPS calls to LLM APIs
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application source and built assets
COPY --from=build /app/src ./src
COPY --from=build /app/bin ./bin
COPY --from=build /app/roles ./roles
COPY --from=build /app/ui/dist ./ui/dist
COPY --from=build /app/ui/public ./ui/public
COPY package.json tsconfig.json ./

# Create non-root user and data directory
RUN groupadd -r jarvis && useradd -r -g jarvis -d /data -s /bin/bash jarvis && \
    mkdir -p /data && chown jarvis:jarvis /data

ENV JARVIS_HOME=/data
ENV NODE_ENV=production

EXPOSE 3142

VOLUME ["/data"]

USER jarvis

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:3142/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "src/daemon/index.ts"]
CMD ["--data-dir", "/data", "--no-local-tools"]
