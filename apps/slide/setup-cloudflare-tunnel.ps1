# PowerShell script for Cloudflare Tunnel Setup
# Run this AFTER deploying the Docker container

Write-Host "🌐 Cloudflare Tunnel Setup for Slide" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Check if cloudflared is installed
$cloudflaredPath = Get-Command cloudflared -ErrorAction SilentlyContinue

if (-not $cloudflaredPath) {
    Write-Host "📥 Installing cloudflared..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please download and install cloudflared from:" -ForegroundColor Yellow
    Write-Host "https://github.com/cloudflare/cloudflared/releases/latest" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Download: cloudflared-windows-amd64.msi" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "After installation, run this script again." -ForegroundColor Cyan
    exit 1
}

Write-Host "✅ cloudflared is installed" -ForegroundColor Green
Write-Host ""

# Check if already authenticated
$cloudflaredDir = "$env:USERPROFILE\.cloudflared"
if (-not (Test-Path "$cloudflaredDir\*.json")) {
    Write-Host "🔐 Authenticating with Cloudflare..." -ForegroundColor Yellow
    Write-Host "    A browser window will open. Please log in to Cloudflare." -ForegroundColor Yellow
    cloudflared tunnel login
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Authentication failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Authentication successful" -ForegroundColor Green
} else {
    Write-Host "✅ Already authenticated with Cloudflare" -ForegroundColor Green
}

Write-Host ""

# Ask for domain name
$domain = Read-Host "📝 Enter your domain name (e.g., slide.yourdomain.com)"

if ([string]::IsNullOrWhiteSpace($domain)) {
    Write-Host "❌ Domain name is required" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "🚇 Creating Cloudflare Tunnel..." -ForegroundColor Cyan

# Create tunnel
$tunnelOutput = cloudflared tunnel create slide-app 2>&1 | Out-String

Write-Host $tunnelOutput

# Extract tunnel ID
$tunnelId = $null
if ($tunnelOutput -match "Created tunnel slide-app with id ([a-f0-9-]+)") {
    $tunnelId = $matches[1]
} elseif ($tunnelOutput -match "([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})") {
    $tunnelId = $matches[1]
}

if (-not $tunnelId) {
    # Tunnel might already exist, try to get it
    $tunnelList = cloudflared tunnel list 2>&1 | Out-String
    if ($tunnelList -match "slide-app\s+([a-f0-9-]+)") {
        $tunnelId = $matches[1]
        Write-Host "ℹ️  Using existing tunnel: $tunnelId" -ForegroundColor Yellow
    }
}

if (-not $tunnelId) {
    Write-Host "❌ Failed to create or find tunnel" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Tunnel ID: $tunnelId" -ForegroundColor Green
Write-Host ""

# Create config directory
$configDir = "$env:USERPROFILE\.cloudflared"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

Write-Host "📁 Creating configuration..." -ForegroundColor Cyan

# Find credentials file
$credFile = Get-ChildItem -Path $configDir -Filter "$tunnelId.json" -ErrorAction SilentlyContinue
if (-not $credFile) {
    Write-Host "⚠️  Credentials file not found at expected location" -ForegroundColor Yellow
    Write-Host "    Looking for: $configDir\$tunnelId.json" -ForegroundColor Yellow
}

# Create config file
$configContent = @"
tunnel: $tunnelId
credentials-file: $configDir\$tunnelId.json

ingress:
  - hostname: $domain
    service: http://localhost:3420
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
      disableChunkedEncoding: true
      http2Origin: false
      keepAlive: 1m
      httpHostHeader: $domain
  - service: http_status:404
"@

$configContent | Out-File -FilePath "$configDir\config.yml" -Encoding utf8
Write-Host "✅ Configuration created at: $configDir\config.yml" -ForegroundColor Green
Write-Host ""

# Route DNS
Write-Host "🌍 Configuring DNS..." -ForegroundColor Cyan
cloudflared tunnel route dns slide-app $domain

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  DNS routing may have failed. You might need to add it manually in Cloudflare dashboard." -ForegroundColor Yellow
} else {
    Write-Host "✅ DNS configured" -ForegroundColor Green
}

Write-Host ""

# Install as service
Write-Host "⚙️  Installing cloudflared as a Windows service..." -ForegroundColor Cyan
Write-Host "    This requires administrator privileges." -ForegroundColor Yellow

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "⚠️  Not running as administrator. Service installation skipped." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To install as a service, run PowerShell as Administrator and execute:" -ForegroundColor Yellow
    Write-Host "    cloudflared service install" -ForegroundColor Cyan
    Write-Host ""
} else {
    cloudflared service install
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Service installed" -ForegroundColor Green
        
        # Start service
        Write-Host "🚀 Starting cloudflared service..." -ForegroundColor Cyan
        Start-Service cloudflared
        
        Write-Host "✅ Service started" -ForegroundColor Green
    } else {
        Write-Host "⚠️  Service installation may have failed" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "================================" -ForegroundColor Green
Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""
Write-Host "Your Slide app should now be accessible at: https://$domain" -ForegroundColor Cyan
Write-Host ""
Write-Host "📝 Next steps:" -ForegroundColor Yellow
Write-Host "   1. Update your .env.production file:" -ForegroundColor White
Write-Host "      ORIGIN=https://$domain" -ForegroundColor Cyan
Write-Host ""
Write-Host "   2. Restart your Docker container:" -ForegroundColor White
Write-Host "      docker-compose down && docker-compose up -d" -ForegroundColor Cyan
Write-Host ""
Write-Host "   3. Check tunnel status:" -ForegroundColor White
Write-Host "      cloudflared tunnel info slide-app" -ForegroundColor Cyan
Write-Host ""
Write-Host "   4. View tunnel logs:" -ForegroundColor White
Write-Host "      Get-EventLog -LogName Application -Source cloudflared -Newest 50" -ForegroundColor Cyan
Write-Host ""
Write-Host "   5. Test your application:" -ForegroundColor White
Write-Host "      Invoke-WebRequest https://$domain" -ForegroundColor Cyan
Write-Host ""

if (-not $isAdmin) {
    Write-Host "⚠️  Remember to install the service as administrator:" -ForegroundColor Yellow
    Write-Host "    Right-click PowerShell -> Run as Administrator" -ForegroundColor White
    Write-Host "    Then run: cloudflared service install" -ForegroundColor Cyan
    Write-Host ""
}
