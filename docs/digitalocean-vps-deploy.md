# DigitalOcean VPS Deployment

This deploy keeps the web UI and daily automation on one persistent VPS. The UI
continues to review runs, backups, rollbacks, and audit history. The daily timer
runs the deterministic CLI instead of clicking the web app.

## Server layout

- App checkout: `/opt/cloudbeds-rates`
- Secrets/env file: `/etc/cloudbeds-rates.env`
- Durable state: `/opt/cloudbeds-rates/data`
- Web service: `cloudbeds-rates.service`
- Daily run: `cloudbeds-rates-daily.service`
- Daily timer: `cloudbeds-rates-daily.timer`

## First-time setup

Run these commands on the Droplet as a sudo-capable user.

```sh
sudo apt-get update
sudo apt-get install -y git curl build-essential

sudo useradd --system --create-home --shell /usr/sbin/nologin cloudbeds-rates
sudo mkdir -p /opt/cloudbeds-rates
sudo chown cloudbeds-rates:cloudbeds-rates /opt/cloudbeds-rates

sudo -u cloudbeds-rates git clone https://github.com/jconn333/cloudbeds-rates.git /opt/cloudbeds-rates
cd /opt/cloudbeds-rates
sudo -u cloudbeds-rates npm ci
```

Install a current Node runtime before `npm ci` if the Droplet does not already
have one. This app uses `node:sqlite`, so use a recent Node version that supports
that built-in module.

## Environment file

Create `/etc/cloudbeds-rates.env` from `.env.example`, owned by root:

```sh
sudo cp /opt/cloudbeds-rates/.env.example /etc/cloudbeds-rates.env
sudo chown root:cloudbeds-rates /etc/cloudbeds-rates.env
sudo chmod 640 /etc/cloudbeds-rates.env
sudo nano /etc/cloudbeds-rates.env
```

Recommended VPS-specific values:

```sh
CLOUDBEDS_RATES_DATA_DIR=/opt/cloudbeds-rates/data
DAILY_RUN_PROPERTIES=berlin-encore,berlin-resort
DAILY_RUN_START_OFFSET_DAYS=364
DAILY_RUN_DAYS_AHEAD=1
DAILY_RUN_OPERATOR=digitalocean-daily
ENABLE_CLOUDBEDS_WRITES=false
HOST=127.0.0.1
PORT=3787
```

Leave `ENABLE_CLOUDBEDS_WRITES=false` for the first VPS smoke test. The daily
runner also requires the explicit `daily:apply` command before writes can happen,
so both gates must be open.

The recommended live rollout starts far in the future and works backward toward
near-term dates. `DAILY_RUN_START_OFFSET_DAYS=364` plus `DAILY_RUN_DAYS_AHEAD=1`
means each daily run covers one night about a year out; the next day's run moves
one night closer to today.

## Install services

```sh
sudo cp /opt/cloudbeds-rates/deploy/systemd/cloudbeds-rates.service /etc/systemd/system/
sudo cp /opt/cloudbeds-rates/deploy/systemd/cloudbeds-rates-daily.service /etc/systemd/system/
sudo cp /opt/cloudbeds-rates/deploy/systemd/cloudbeds-rates-daily.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

## Smoke tests

```sh
cd /opt/cloudbeds-rates
sudo -u cloudbeds-rates env CLOUDBEDS_RATES_ENV_FILE=/etc/cloudbeds-rates.env npm run preflight
sudo -u cloudbeds-rates bash -lc 'set -a; . /etc/cloudbeds-rates.env; set +a; cd /opt/cloudbeds-rates; npm run daily:plan'
sudo systemctl start cloudbeds-rates
sudo systemctl status cloudbeds-rates --no-pager
```

If the plan and UI look right, enable the web service:

```sh
sudo systemctl enable --now cloudbeds-rates
```

## Enable the daily timer

Only after a clean dry-run plan:

```sh
sudo systemctl enable --now cloudbeds-rates-daily.timer
systemctl list-timers cloudbeds-rates-daily.timer
```

When ready for live writes, edit `/etc/cloudbeds-rates.env`:

```sh
ENABLE_CLOUDBEDS_WRITES=true
```

Then reload and test one controlled manual run:

```sh
sudo systemctl daemon-reload
sudo systemctl start cloudbeds-rates-daily.service
sudo journalctl -u cloudbeds-rates-daily.service -n 100 --no-pager
```

## Operations

Web app logs:

```sh
sudo journalctl -u cloudbeds-rates -f
```

Daily run logs:

```sh
sudo journalctl -u cloudbeds-rates-daily.service -n 200 --no-pager
```

Timer status:

```sh
systemctl list-timers cloudbeds-rates-daily.timer
```

Pause automation:

```sh
sudo systemctl disable --now cloudbeds-rates-daily.timer
```

Restart web UI after deploying code:

```sh
cd /opt/cloudbeds-rates
sudo -u cloudbeds-rates git pull --ff-only
sudo -u cloudbeds-rates npm ci
sudo systemctl restart cloudbeds-rates
```
