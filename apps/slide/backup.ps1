# PowerShell backup script for Slide production database

# Configuration
$BackupDir = ".\backups"
$ContainerName = "slide-app"
$DbPath = "/app/data/prod.db"
$Date = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupFile = "$BackupDir\slide-backup-$Date.db"

# Create backup directory if it doesn't exist
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

Write-Host "Creating backup of Slide database..." -ForegroundColor Cyan
Write-Host "Timestamp: $Date" -ForegroundColor Gray

# Check if container is running
$containerRunning = docker ps --format "{{.Names}}" | Select-String -Pattern $ContainerName

if (-not $containerRunning) {
    Write-Host "[ERROR] Container '$ContainerName' is not running" -ForegroundColor Red
    exit 1
}

# Create backup
docker cp "${ContainerName}:${DbPath}" $BackupFile

if ($LASTEXITCODE -eq 0) {
    # Get file size
    $fileInfo = Get-Item $BackupFile
    $size = "{0:N2} MB" -f ($fileInfo.Length / 1MB)
    
    Write-Host "[SUCCESS] Backup created successfully!" -ForegroundColor Green
    Write-Host "Location: $BackupFile" -ForegroundColor Cyan
    Write-Host "Size: $size" -ForegroundColor Cyan
    
    # Optional: Delete backups older than 30 days
    Write-Host ""
    Write-Host "Cleaning up old backups (older than 30 days)..." -ForegroundColor Yellow
    $oldBackups = Get-ChildItem -Path $BackupDir -Filter "slide-backup-*.db" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) }
    
    foreach ($backup in $oldBackups) {
        Remove-Item $backup.FullName
        Write-Host "  Deleted: $($backup.Name)" -ForegroundColor Gray
    }
    
    # Count remaining backups
    $backupCount = (Get-ChildItem -Path $BackupDir -Filter "slide-backup-*.db").Count
    Write-Host "Total backups: $backupCount" -ForegroundColor Cyan
} else {
    Write-Host "[ERROR] Backup failed!" -ForegroundColor Red
    exit 1
}
