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

The application now runs on port **3420** by default (instead of 3000/3001).

Update your Cloudflare Tunnel configuration to use `http://localhost:3420`.
