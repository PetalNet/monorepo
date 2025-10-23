# PowerShell deployment script for production
# Run this on your Windows server

Write-Host "🚀 Starting Slide deployment..." -ForegroundColor Cyan

# Check if Docker is installed
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Docker is not installed. Please install Docker Desktop first." -ForegroundColor Red
    Write-Host "   Download from: https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    exit 1
}

# Check if Docker is running
try {
    docker ps | Out-Null
} catch {
    Write-Host "❌ Docker is not running. Please start Docker Desktop." -ForegroundColor Red
    exit 1
}

# Check if .env.production exists
if (-not (Test-Path .env.production)) {
    Write-Host "⚠️  .env.production not found. Creating from example..." -ForegroundColor Yellow
    Copy-Item .env.production.example .env.production
    Write-Host "📝 Please edit .env.production and set your ORIGIN and ADMIN_EMAIL before continuing." -ForegroundColor Yellow
    Write-Host "   Example: ORIGIN=https://yourdomain.com" -ForegroundColor Yellow
    Write-Host "   Example: ADMIN_EMAIL=admin@yourdomain.com" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "After editing, run this script again." -ForegroundColor Cyan
    exit 1
}

# Build the Docker image
Write-Host "📦 Building Docker image..." -ForegroundColor Cyan
docker-compose build

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed. Please check the errors above." -ForegroundColor Red
    exit 1
}

# Start the application
Write-Host "🔄 Starting application..." -ForegroundColor Cyan
docker-compose up -d

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to start application. Please check the errors above." -ForegroundColor Red
    exit 1
}

# Wait a moment for the container to start
Start-Sleep -Seconds 5

# Check if container is running
$containerStatus = docker-compose ps --format json | ConvertFrom-Json
$isRunning = $containerStatus | Where-Object { $_.State -eq "running" }

if ($isRunning) {
    Write-Host "✅ Application started successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📊 Container status:" -ForegroundColor Cyan
    docker-compose ps
    Write-Host ""
    Write-Host "📝 To view logs, run: docker-compose logs -f" -ForegroundColor Yellow
    Write-Host "🌐 Application should be available at: http://localhost:3420" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "💡 Next steps:" -ForegroundColor Cyan
    Write-Host "   1. Set up Cloudflare Tunnel (run .\setup-cloudflare-tunnel.ps1)" -ForegroundColor White
    Write-Host "   2. Configure your domain DNS to point to Cloudflare" -ForegroundColor White
    Write-Host "   3. Set up automated backups (use Task Scheduler)" -ForegroundColor White
    Write-Host ""
    Write-Host "📖 See DEPLOYMENT.md for detailed instructions" -ForegroundColor Yellow
} else {
    Write-Host "❌ Application failed to start. Checking logs..." -ForegroundColor Red
    docker-compose logs
}
