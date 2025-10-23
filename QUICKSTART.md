# Quick Start - Production Deployment with Cloudflare Tunnel

This is a streamlined guide to get your Slide app running in production using Docker and Cloudflare Tunnel.

## Prerequisites

- A remote server (VPS, cloud instance, etc.) running Linux
- A domain name configured in Cloudflare
- SSH access to your server

## Step-by-Step Deployment

### 1️⃣ On Your Remote Server

SSH into your server:
```bash
ssh user@your-server-ip
```

Install Docker and Docker Compose:
```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo apt-get update
sudo apt-get install docker-compose-plugin

# Add your user to docker group (optional, to run without sudo)
sudo usermod -aG docker $USER
```

### 2️⃣ Clone and Configure

Clone your repository:
```bash
git clone <your-repo-url>
cd slide
```

Create production environment file:
```bash
cp .env.production.example .env.production
nano .env.production
```

Set your domain (you'll configure this in Cloudflare):
```env
ORIGIN=https://slide.yourdomain.com
DATABASE_URL=file:/app/data/prod.db
NODE_ENV=production
```

### 3️⃣ Deploy the Application

Run the deployment script:
```bash
./deploy.sh
```

This will:
- Build the Docker image
- Start the application on `localhost:3000`
- Run database migrations
- Verify everything is running

### 4️⃣ Set Up Cloudflare Tunnel

Run the automated setup script:
```bash
./setup-cloudflare-tunnel.sh
```

This will:
- Install cloudflared
- Authenticate with Cloudflare
- Create a tunnel
- Configure DNS
- Set up the service

When prompted, enter your domain (e.g., `slide.yourdomain.com`)

### 5️⃣ Verify Deployment

Check that everything is running:
```bash
# Check Docker container
docker-compose ps

# Check Cloudflare Tunnel
sudo systemctl status cloudflared

# Test the application
curl https://slide.yourdomain.com
```

## That's It! 🎉

Your Slide app should now be live at `https://slide.yourdomain.com`

## Updating the Application

When you make changes:

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose build
docker-compose up -d

# Check logs
docker-compose logs -f
```

## Troubleshooting

### Application won't start
```bash
# Check logs
docker-compose logs -f slide

# Restart container
docker-compose restart
```

### Cloudflare Tunnel issues
```bash
# Check tunnel logs
sudo journalctl -u cloudflared -f

# Restart tunnel
sudo systemctl restart cloudflared

# Check tunnel status
cloudflared tunnel list
```

### Database issues
```bash
# Access container
docker-compose exec slide sh

# Check database
ls -la /app/data/

# Run migrations manually
pnpm prisma migrate deploy
```

## Backup Your Database

Create a backup script:
```bash
#!/bin/bash
DATE=$(date +%Y%m%d-%H%M%S)
docker cp slide-app:/app/data/prod.db ./backups/prod-$DATE.db
echo "Backup created: prod-$DATE.db"
```

Run it regularly or set up a cron job:
```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * /path/to/backup-script.sh
```

## Need More Help?

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed documentation including:
- Advanced Cloudflare configuration
- Security best practices
- Performance optimization
- Monitoring and maintenance

## Support

If you encounter issues:
1. Check the logs: `docker-compose logs -f`
2. Check tunnel logs: `sudo journalctl -u cloudflared -f`
3. Verify your `.env.production` settings
4. Ensure your domain DNS is properly configured in Cloudflare
