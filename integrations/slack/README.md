# The Vestiarion Slack app

`manifest.yaml` is the app, as created at https://api.slack.com/apps with **Create New App**, **From a manifest**
(docs/superpowers/specs/2026-10-03-slack-design.md). It asks for three scopes: `commands` and `incoming-webhook`, so
the app answers `/vestiarion` and posts to the one channel picked when a workspace connects it, and `files:read`, so it
can read the file someone chooses with the message shortcut **Add invoice**. It reads no other message
or file.

1. Create the app from the manifest. Slack checks the events URL as it saves, so on a deployment that does not serve
   `/api/slack/events` yet, delete the `event_subscriptions` block first and add it back (**Event Subscriptions**, or
   the **App Manifest** page) once it does.
2. From **Basic Information**, **App Credentials**, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and
   `SLACK_SIGNING_SECRET` on the deployment. With any of them missing, Slack is off.
3. To let workspaces other than the one the app was created in connect it, turn on **Manage Distribution**, **Public
   Distribution**. No listing in the Slack Marketplace is needed.

A deployment on another host changes the four `https://www.vestiarion.xyz/...` URLs to its own.

**An app created from an earlier manifest** (before the shortcut and `files:read`): on the **App Manifest** page, paste
this manifest and save. Then, in each workspace that connected Slack, an owner or admin chooses **Reconnect Slack** in
Settings once, to grant `files:read`. Until then, Add invoice answers that Slack must be connected again.
