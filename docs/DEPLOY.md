# Deploying Dropisode

Production runs on one AWS EC2 server (t4g.medium, eu-west-2, in the same AWS account as Glasstrack) behind Cloudflare. Postgres runs on the server; media and backups live in Cloudflare R2 (bucket `dropisode-media`).

| Piece | Where |
|---|---|
| Server | EC2 `dropisode-prod`, Elastic IP, SSH key `~/.ssh/dropisode_ec2` (user `ubuntu`) |
| Firewall | Security group `dropisode-prod`: 80/443 from Cloudflare's ranges only, SSH from the owner's IP only |
| App | `/srv/dropisode/src` (Docker Compose: postgres, app, caddy); secrets in `/srv/dropisode/.env` (mode 600) |
| TLS | Caddy gets a Let's Encrypt certificate over HTTP-01 through Cloudflare; Cloudflare SSL mode "Full (strict)", HTTPS forced, HSTS on |
| DNS | dropisode.com in Cloudflare (A + www, proxied); SES DKIM, MAIL FROM `mail.dropisode.com`, DMARC |
| Email | Amazon SES (eu-west-2), IAM user `dropisode-ses-smtp` may only send as `*@dropisode.com` |
| Backups | Nightly 03:15 UTC: `pg_dump` to `/srv/dropisode/backups` (14 days) and R2 `backups/` (30 days); `/srv/dropisode/backup.sh` |
| Alerts | `deploy/alerts/setup.sh`: Lambda `dropisode-alerts` checks `/health` every 5 minutes and disk hourly; CloudWatch alarms (site down, status check, CPU, disk) post to Telegram |

## Deploy

Ships the committed `HEAD` (never uncommitted work) and rebuilds on the server:

```sh
DEPLOY_HOST=ubuntu@<elastic ip> DEPLOY_KEY=~/.ssh/dropisode_ec2 sh deploy/deploy.sh
```

Take a backup first when a release has a migration: `ssh ... /srv/dropisode/backup.sh`.

## Restore drill

Restore the newest dump into a scratch database and compare row counts with the live one (done on first deploy, 2026-10-30, passed):

```sh
docker exec src-postgres-1 createdb -U reel reel_restore_drill
docker exec -i src-postgres-1 pg_restore -U reel --no-owner -d reel_restore_drill < /srv/dropisode/backups/<newest>.dump
```

## Switching billing on

Billing is off: generation is refused with "not open yet". To open it, create the Stripe account, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BILLING_ENABLED=true` in `/srv/dropisode/.env`, add the webhook `https://dropisode.com/webhooks/stripe` (events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`), and redeploy.
