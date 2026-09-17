# TLS + nginx notes

**Two hostnames serve this app**: `diudara2.mhamzah.id` and `diudara.mhamzah.id`.
Neither redirects to the other. Each has its own Let's Encrypt certificate and its
own published bundle (`/var/www/html/diudara2/dist`, `/var/www/html/diudara/dist`),
and the two site files in `nginx/` are otherwise identical — server_name, cert and
root are the ONLY differences. Fix a location block in one, fix it in the other.

`scripts/deploy.sh` publishes both and verifies both (`/`, `/api` returns JSON,
`/hls` reaches MediaMTX), so the commands below are only for bootstrapping a new
host or recovering by hand.

**RTMP does not go through these hosts.** OBS dials `stream.mhamzah.id:1935`
directly — a DNS-only record pointing at the origin. Both site names are proxied
by Cloudflare, which forwards HTTP/HTTPS only, so an RTMP URL built from them
fails to connect with nothing reaching this box. That host is set explicitly in
`backend/.env` as `MEDIAMTX_RTMP_HOST`.

## Bootstrapping a host by hand

```sh
sudo certbot certonly --nginx -d diudara2.mhamzah.id   # and -d diudara.mhamzah.id
```

```sh
sudo cp nginx/diudara2.mhamzah.id /etc/nginx/sites-available/diudara2.mhamzah.id
```

```sh
sudo ln -s /etc/nginx/sites-available/diudara2.mhamzah.id /etc/nginx/sites-enabled/diudara2.mhamzah.id

# remove
sudo unlink -s /etc/nginx/sites-available/diudara2.mhamzah.id /etc/nginx/sites-enabled/diudara2.mhamzah.id
```

```sh
sudo nginx -t;
```

```sh
sudo systemctl reload nginx; # OR
sudo systemctl restart nginx; # OR
sudo systemctl status nginx; 
```