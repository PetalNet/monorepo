# Docker Deployment Guide (Cloudflare Tunnel)

This guide explains how to deploy the Slide application using Docker on a remote machine with Cloudflare Tunnel.

## Prerequisites

On your remote machine, ensure you have:
- Docker installed (version 20.10 or higher)
- Docker Compose installed (version 2.0 or higher)
- Git (to clone the repository)
- Cloudflare Tunnel (cloudflared) installed and configured

## Initial Setup

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd slide
```

### 2. Configure Environment Variables

Create a `.env.production` file in the project root:

```bash
cp .env.production.example .env.production
```

Edit `.env.production` and set your production domain:

```bash
ORIGIN=https://yourdomain.com
```

### 3. Build and Start the Application

```bash
# Build the Docker image
docker-compose build

# Start the application
docker-compose up -d
```

The application will:
1. Build the production image
2. Run database migrations automatically
3. Start the application on port 3000

### 4. Set Up Cloudflare Tunnel

If you haven't already installed cloudflared:

```bash
# For Ubuntu/Debian
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# For other systems, see: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

Authenticate with Cloudflare:

```bash
cloudflared tunnel login
```

Create and configure your tunnel:

```bash
# Create a tunnel
cloudflared tunnel create slide-app

# Note the tunnel ID shown in the output

# Create config file
sudo mkdir -p /etc/cloudflared
sudo nano /etc/cloudflared/config.yml
```

Add this configuration to `/etc/cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /root/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: yourdomain.com
    service: http://localhost:3000
    originRequest:
      noTLSVerify: false
      connectTimeout: 30s
      # Important for SSE (Server-Sent Events)
      disableChunkedEncoding: true
      http2Origin: false
  - service: http_status:404
```

Route your tunnel to your domain:

```bash
cloudflared tunnel route dns slide-app yourdomain.com
```

Install and start the tunnel as a service:

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

### 5. Verify Everything is Running

```bash
# Check Docker container status
docker-compose ps

# View application logs
docker-compose logs -f slide

# Check Cloudflare Tunnel status
sudo systemctl status cloudflared

# Test local application
curl http://localhost:3000

# Test through Cloudflare Tunnel
curl https://yourdomain.com
```

## Cloudflare Tunnel Benefits

Using Cloudflare Tunnel provides:
- ✅ **Automatic SSL/TLS**: No need to manage certificates
- ✅ **DDoS Protection**: Built-in Cloudflare security
- ✅ **No Open Ports**: No need to expose ports 80/443 to the internet
- ✅ **Free**: No cost for Cloudflare Tunnel
- ✅ **Easy DNS**: Automatic DNS configuration
- ✅ **Zero Trust**: Can add authentication if needed

## Common Operations

### Update the Application

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose build
docker-compose up -d

# View logs to ensure successful restart
docker-compose logs -f slide
```

### Backup the Database

```bash
# Create backup directory
mkdir -p backups

# Backup the database
docker cp slide-app:/app/data/prod.db ./backups/prod-$(date +%Y%m%d-%H%M%S).db
```

### Restore the Database

```bash
# Stop the application
docker-compose down

# Restore the database file
docker cp ./backups/prod-YYYYMMDD-HHMMSS.db slide-app:/app/data/prod.db

# Start the application
docker-compose up -d
```

### View Logs

```bash
# View all logs
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# View logs for specific service
docker-compose logs -f slide
```

### Restart the Application

```bash
docker-compose restart
```

### Stop the Application

```bash
docker-compose down
```

### Remove Everything (including volumes)

```bash
docker-compose down -v
```

## Database Migrations

Migrations are automatically applied when the container starts. If you need to run migrations manually:

```bash
docker-compose exec slide pnpm prisma migrate deploy
```

## Monitoring and Maintenance

### Check Disk Usage

```bash
# Check volume size
docker system df -v

# Check container logs size
docker ps -q | xargs docker inspect --format='{{.LogPath}}' | xargs ls -lh
```

### Clean Up Docker Resources

```bash
# Remove unused images
docker image prune -a

# Remove unused volumes
docker volume prune

# Remove everything unused
docker system prune -a --volumes
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker-compose logs slide

# Check if port is already in use
sudo lsof -i :3000

# Restart Docker
sudo systemctl restart docker
```

### Database issues

```bash
# Access the container
docker-compose exec slide sh

# Check database file
ls -la /app/data/

# Run Prisma commands
pnpm prisma studio
```

### Permission issues

```bash
# Fix volume permissions
docker-compose down
sudo chown -R 1000:1000 ./data
docker-compose up -d
```

## Cloudflare Tunnel Management

### View Tunnel Logs

```bash
sudo journalctl -u cloudflared -f
```

### Restart Tunnel

```bash
sudo systemctl restart cloudflared
```

### Update Tunnel Configuration

```bash
# Edit config
sudo nano /etc/cloudflared/config.yml

# Restart to apply changes
sudo systemctl restart cloudflared
```

### Add Access Policies (Optional)

You can add Cloudflare Access to require authentication:

1. Go to Cloudflare Dashboard → Zero Trust → Access → Applications
2. Add Application → Self-hosted
3. Configure your authentication requirements
4. Apply policies to your domain

## Security Considerations

1. **Change default passwords**: Ensure all user accounts use strong passwords
2. **Cloudflare SSL**: Enabled automatically via Cloudflare Tunnel
3. **Firewall**: No need to expose ports 80/443 - Cloudflare Tunnel handles this
4. **Regular updates**: Keep Docker, cloudflared, and the application updated
5. **Backup regularly**: Set up automated database backups
6. **Environment variables**: Never commit `.env.production` to version control
7. **Monitor logs**: Regularly check both application and tunnel logs
8. **Cloudflare WAF**: Consider enabling Web Application Firewall rules
9. **Rate limiting**: Use Cloudflare's rate limiting features

## Performance Optimization

1. **Use Docker volumes**: For better I/O performance
2. **Limit logs**: Configure log rotation to prevent disk space issues
3. **Health checks**: Monitor application health
4. **Resource limits**: Set memory and CPU limits in docker-compose.yml if needed

Example resource limits:
```yaml
services:
  slide:
    # ... other config
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```
