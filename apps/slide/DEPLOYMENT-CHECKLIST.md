# 🚀 Production Deployment Checklist

Use this checklist when deploying Slide to production.

## Pre-Deployment

### Server Setup

- [ ] Server provisioned (VPS/Cloud instance)
- [ ] SSH access configured
- [ ] Docker installed (`docker --version`)
- [ ] Docker Compose installed (`docker-compose --version`)
- [ ] Domain name registered and pointing to Cloudflare
- [ ] Sufficient disk space (minimum 10GB recommended)

### Code Preparation

- [ ] All code committed to git
- [ ] Repository pushed to remote (GitHub, GitLab, etc.)
- [ ] `.env.production` NOT committed to git
- [ ] Production dependencies verified in `package.json`

## Deployment Steps

### 1. Server Preparation

- [ ] SSH into server: `ssh user@your-server-ip`
- [ ] Update system: `sudo apt-get update && sudo apt-get upgrade`
- [ ] Install git if needed: `sudo apt-get install git`
- [ ] Create application directory: `mkdir -p ~/apps && cd ~/apps`

### 2. Application Setup

- [ ] Clone repository: `git clone <repo-url> slide`
- [ ] Navigate to directory: `cd slide`
- [ ] Copy environment template: `cp .env.production.example .env.production`
- [ ] Edit `.env.production`: `nano .env.production`
- [ ] Set ORIGIN to your domain: `ORIGIN=https://yourdomain.com`

### 3. Docker Deployment

- [ ] Run deployment script: `./deploy.sh`
- [ ] Verify build completed successfully
- [ ] Check container is running: `docker-compose ps`
- [ ] Check logs for errors: `docker-compose logs -f slide`
- [ ] Test local access: `curl http://localhost:3000/health`

### 4. Cloudflare Tunnel Setup

- [ ] Run tunnel setup: `./setup-cloudflare-tunnel.sh`
- [ ] Complete Cloudflare authentication in browser
- [ ] Enter your domain when prompted
- [ ] Verify tunnel created: `cloudflared tunnel list`
- [ ] Check tunnel service: `sudo systemctl status cloudflared`
- [ ] Verify DNS configured in Cloudflare dashboard

### 5. Verification

- [ ] Test domain access: `curl https://yourdomain.com/health`
- [ ] Test in browser: `https://yourdomain.com`
- [ ] Create test user account
- [ ] Create test event
- [ ] Verify SSE (Server-Sent Events) working for live updates
- [ ] Test join code functionality
- [ ] Verify voting works
- [ ] Check mobile responsiveness

## Post-Deployment

### Security

- [ ] Change all default passwords
- [ ] Verify HTTPS is working (Cloudflare SSL)
- [ ] Review Cloudflare security settings
- [ ] Enable Cloudflare WAF (optional but recommended)
- [ ] Set up rate limiting in Cloudflare (optional)
- [ ] Review application logs for suspicious activity

### Backups

- [ ] Test backup script: `./backup.sh`
- [ ] Verify backup created in `./backups/` directory
- [ ] Set up automated backups with cron:
  ```bash
  crontab -e
  # Add: 0 2 * * * cd ~/apps/slide && ./backup.sh >> /var/log/slide-backup.log 2>&1
  ```
- [ ] Test backup restoration process
- [ ] Document backup location and schedule

### Monitoring

- [ ] Set up uptime monitoring (UptimeRobot, Pingdom, etc.)
- [ ] Configure email alerts for downtime
- [ ] Set up log monitoring (optional)
- [ ] Test health endpoint: `/health`
- [ ] Document monitoring dashboard locations

### Performance

- [ ] Check application response time
- [ ] Verify SSE connections work properly
- [ ] Test with multiple concurrent users
- [ ] Monitor server resources (CPU, RAM, Disk)
- [ ] Configure Cloudflare caching rules (if needed)

### Documentation

- [ ] Document server access credentials (securely!)
- [ ] Document Cloudflare account details
- [ ] Document backup procedures
- [ ] Document rollback procedures
- [ ] Create runbook for common operations
- [ ] Share access with team members (if applicable)

## Maintenance Schedule

### Daily

- [ ] Check application status: `docker-compose ps`
- [ ] Review application logs for errors
- [ ] Verify backups are running

### Weekly

- [ ] Review Cloudflare analytics
- [ ] Check disk space usage: `df -h`
- [ ] Review security logs
- [ ] Test backup restoration

### Monthly

- [ ] Update system packages: `sudo apt-get update && sudo apt-get upgrade`
- [ ] Review and rotate logs if needed
- [ ] Audit user accounts
- [ ] Review Cloudflare security settings
- [ ] Update Docker images if needed

### As Needed

- [ ] Deploy application updates: `git pull && docker-compose build && docker-compose up -d`
- [ ] Update Cloudflare Tunnel: `sudo cloudflared update`
- [ ] Scale resources if needed

## Troubleshooting Reference

### Application won't start

```bash
docker-compose logs -f slide
docker-compose restart
```

### Cloudflare Tunnel issues

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -f
sudo systemctl restart cloudflared
```

### Database issues

```bash
docker-compose exec slide sh
ls -la /app/data/
pnpm prisma migrate status
```

### Out of disk space

```bash
# Check usage
df -h
docker system df

# Clean up
docker system prune -a
find ./backups -type f -mtime +30 -delete
```

## Rollback Procedure

If something goes wrong:

1. Stop the application:

   ```bash
   docker-compose down
   ```

2. Restore previous version:

   ```bash
   git checkout <previous-commit>
   docker-compose build
   ```

3. Restore database if needed:

   ```bash
   docker cp ./backups/slide-backup-YYYYMMDD-HHMMSS.db slide-app:/app/data/prod.db
   ```

4. Restart:
   ```bash
   docker-compose up -d
   ```

## Emergency Contacts

- [ ] Server provider support: ********\_********
- [ ] Domain registrar support: ********\_********
- [ ] Cloudflare support: https://support.cloudflare.com
- [ ] Team lead/DevOps contact: ********\_********

## Notes

_Add any deployment-specific notes, gotchas, or customizations here:_

---

**Deployment Date:** ********\_\_\_********

**Deployed By:** ********\_\_\_********

**Production URL:** ********\_\_\_********

**Server IP:** ********\_\_\_********

**Cloudflare Tunnel ID:** ********\_\_\_********
