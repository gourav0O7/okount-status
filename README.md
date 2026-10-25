# Okount status

Live page: https://gourav0o7.github.io/okount-status/

Every 5 minutes a GitHub Action (`.github/workflows/status.yml`) runs `check.mjs`,
which asks each service in `services.json` whether it is answering, writes the
result to `data/`, and republishes the page. Free: public repo, GitHub Actions
and GitHub Pages.

- **Down for two checks in a row** → an issue labelled `outage` opens here, so
  the repo owner gets an email. It closes itself when the service is back.
- **The app reads** `https://gourav0o7.github.io/okount-status/data/status.json`
  to show an outage banner.
- **Add or change a service:** edit `services.json`. `"planned": "why"` shows it
  as "Not live yet" without checking it or raising alerts; remove that line
  when it goes live.

No keys or secrets are needed or stored: an answer below 500 (including
"not signed in") counts as working. GitHub may run a scheduled check a few
minutes late when it is busy.
