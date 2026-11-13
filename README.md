# dn-watcher

Pushes a notification to your phone (via [ntfy](https://ntfy.sh)) the moment something new appears on
DN Fastigheter's page for available apartments: https://dnfast.se/lediga-objekt/lediga-laegenheter/

DN posts new apartments on weekdays between 07:00 and 10:00, so a GitHub Actions job polls the page once a minute
in that window (Swedish time, daylight-saving safe) and exits otherwise.

- Every line of page text it has seen is remembered in `state.json`. New text = alert. An apartment that disappears does
  not alert; a second apartment appearing later alerts again. The first run only records a baseline.
- Needs one repository secret: `NTFY_TOPIC` (the topic you subscribe to in the ntfy app; keep it secret).
- Test: `npm test` (fake page + fake ntfy). Manual run in Actions: "Run workflow" with *force* ticked.
- `state.json` is committed after every run, which also keeps GitHub from pausing the schedule after 60 idle days.
