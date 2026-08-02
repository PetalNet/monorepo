# Admin Access Setup

The admin panel is accessible at `/admin` and is restricted to a specific email address set via environment variable.

## Setting Up Admin Access

### Development

Add to your `.env` file:

```bash
ADMIN_EMAIL=your-email@example.com
```

### Production

Add to your `.env.production` file:

```bash
ADMIN_EMAIL=admin@yourdomain.com
```

Or set it in docker-compose.yml:

```yaml
environment:
  - ADMIN_EMAIL=admin@yourdomain.com
```

## Accessing the Admin Panel

1. Create a user account with the email specified in `ADMIN_EMAIL`
2. Log in with that account
3. Navigate to `/admin`

## Admin Panel Features

- **Dashboard** - Overview of system stats, uptime, memory usage
- **Users** - View and manage all users (can delete users)
- **Events** - View all events with details and stats
- **Storage** - Database size and record counts
- **System** - Process information, memory usage, system details

## Security Notes

- The admin user cannot be deleted from the admin panel
- Only the email matching `ADMIN_EMAIL` can access `/admin`
- No database flag is used - purely environment-based
- Change the `ADMIN_EMAIL` at any time by updating the environment variable and restarting

## Port Configuration

The Node adapter reads `PORT`; the container deployment sets it to **3420**. Other deployments
may choose a different port (and development uses Vite's configured/default port).

Configure any reverse proxy or tunnel to target the host and port used by that deployment. The
included Compose file binds the service on loopback port 3420 for its Cloudflare Tunnel setup;
that tunnel is deployment-specific, not an application requirement.
