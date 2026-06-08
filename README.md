# Getting started

## Step 1 — Get set up
1. Make sure you have Claude Code installed and licensed (optional)
2. Ask Michael to add you to the GitHub repo: `bcgx-pi-60017564-1-2/tenyks`
3. Clone it: `git clone https://github.com/bcgx-pi-60017564-1-2/tenyks.git`


## Step 2 — Build your app

1. Create a folder for your app: `mkdir myapp`
2. Build it as a Flask Blueprint inside that folder
Register it in `app.py` at `/myapp`
3. If you need DB tables, add a `migrate_myapp.py` script with your `CREATE TABLE` statements
Test it locally with `flask run --port 5001` (password: `tenyks2026`)


## Step 3 — Ship it

1. Add your tile to apps.json (copy an existing entry and edit name, description, icon, url, accent color)
2. Open a Pull Request on GitHub
3. Michael reviews, runs your migration script on the shared DB, merges
4. Auto-deploys to vantage.bcg.com/myapp within minutes