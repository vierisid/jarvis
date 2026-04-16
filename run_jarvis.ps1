# Ensure Docker is running
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) {
    Write-Host "Starting Docker Desktop..." -ForegroundColor Cyan
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    Write-Host "Please wait for Docker to initialize and try running this script again." -ForegroundColor Yellow
    exit
}

# Check if network exists
if (-not (docker network ls --filter name=jarvis-net -q)) {
    Write-Host "Creating jarvis-net network..." -ForegroundColor Green
    docker network create jarvis-net
}

# Build the local image (capturing Sarvam and line-ending fixes)
Write-Host "Building JARVIS image from local source..." -ForegroundColor Green
docker build -t jarvis-jarvis .

# Clean up existing standalone container if it exists
if (docker ps -a --filter name=jarvis -q) {
    Write-Host "Stopping and removing existing JARVIS container..." -ForegroundColor Yellow
    docker stop jarvis
    docker rm jarvis
}

# Run the container (flat structure, no project folder)
Write-Host "Starting JARVIS container (standalone)..." -ForegroundColor Green
docker run -d `
  --name jarvis `
  -p 3142:3142 `
  -v jarvis-data:/data `
  -v "${PWD}/config.yaml:/data/config.yaml" `
  -e JARVIS_API_KEY=sk-ant-your-key `
  --network jarvis-net `
  --restart unless-stopped `
  jarvis-jarvis

Write-Host "JARVIS is running at http://localhost:3142" -ForegroundColor Cyan
Write-Host "Check logs with: docker logs -f jarvis" -ForegroundColor Cyan
