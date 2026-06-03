#!/bin/bash

# Quick deployment script for production
# Run this on your remote server

echo "🚀 Starting Slide deployment..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Check if .env.production exists
if [ ! -f .env.production ]; then
    echo "⚠️  .env.production not found. Creating from example..."
    cp .env.production.example .env.production
    echo "📝 Please edit .env.production and set your ORIGIN before continuing."
    echo "   Example: ORIGIN=https://yourdomain.com"
    exit 1
fi

# Build the Docker image
echo "📦 Building Docker image..."
docker-compose build

if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please check the errors above."
    exit 1
fi

# Start the application
echo "🔄 Starting application..."
docker-compose up -d

if [ $? -ne 0 ]; then
    echo "❌ Failed to start application. Please check the errors above."
    exit 1
fi

# Wait a moment for the container to start
sleep 5

# Check if container is running
if docker-compose ps | grep -q "Up"; then
    echo "✅ Application started successfully!"
    echo ""
    echo "📊 Container status:"
    docker-compose ps
    echo ""
    echo "📝 To view logs, run: docker-compose logs -f"
    echo "🌐 Application should be available at: http://localhost:3000"
    echo ""
    echo "💡 Next steps:"
    echo "   1. Set up a reverse proxy (Nginx) with SSL"
    echo "   2. Configure your domain DNS to point to this server"
    echo "   3. Set up automated backups"
    echo ""
    echo "📖 See DEPLOYMENT.md for detailed instructions"
else
    echo "❌ Application failed to start. Checking logs..."
    docker-compose logs
fi
