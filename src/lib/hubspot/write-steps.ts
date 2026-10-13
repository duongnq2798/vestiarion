/**
 * What to do in HubSpot to let Vestiarion write, in the connect page's and the Settings card's words. HubSpot lists the
 * write scopes as optional permissions on its install screen, unticked. In an account that approved the app before,
 * HubSpot shows them locked there until a super admin turns them on in the app's Data Permissions.
 */
export const HUBSPOT_WRITE_STEPS = {
  tick: "On HubSpot's install screen, tick both optional write permissions.",
  locked:
    "If your HubSpot account approved Vestiarion before, they show locked there: a super admin first turns them on in HubSpot > Settings > Integrations > Connected Apps > Vestiarion > Data Permissions.",
} as const;
