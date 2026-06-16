#!/bin/bash

# Backup script for Slide production database

# Configuration
BACKUP_DIR="./backups"
CONTAINER_NAME="slide-app"
DB_PATH="/app/data/prod.db"
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/slide-backup-$DATE.db"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

echo "🔄 Creating backup of Slide database..."
echo "Timestamp: $DATE"

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo "❌ Error: Container '$CONTAINER_NAME' is not running"
    exit 1
fi

# Create backup
docker cp "$CONTAINER_NAME:$DB_PATH" "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    # Get file size
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    
    echo "✅ Backup created successfully!"
    echo "📁 Location: $BACKUP_FILE"
    echo "💾 Size: $SIZE"
    
    # Optional: Delete backups older than 30 days
    echo ""
    echo "🧹 Cleaning up old backups (older than 30 days)..."
    find "$BACKUP_DIR" -name "slide-backup-*.db" -type f -mtime +30 -delete
    
    # Count remaining backups
    BACKUP_COUNT=$(find "$BACKUP_DIR" -name "slide-backup-*.db" -type f | wc -l)
    echo "📊 Total backups: $BACKUP_COUNT"
else
    echo "❌ Backup failed!"
    exit 1
fi
