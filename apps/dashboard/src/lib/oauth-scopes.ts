/**
 * What each scope an agent may ask for means, in the words the consent page
 * shows (design §3.2, contract §4 "Agents act through an OAuth grant").
 *
 * One table, in the order the page lists them. `offline_access` is not in it:
 * it only lets the agent renew its 10-minute access without asking again, so
 * the page states it instead of offering a checkbox that would break the agent.
 */

export interface ScopeCopy {
  scope: string;
  title: string;
  detail: string;
}

export const OFFLINE_ACCESS = "offline_access";

export const SCOPE_COPY: readonly ScopeCopy[] = [
  {
    scope: "eccos:view",
    title: "View the workspace",
    detail:
      "Status, numbers, templates and logs. Message content and phone numbers it reads may reach the agent's model provider.",
  },
  {
    scope: "eccos:operate",
    title: "Operate deliveries",
    detail: "Retry deliveries, cancel broadcasts and scheduled sends, and read the webhook configuration.",
  },
  {
    scope: "eccos:send",
    title: "Send messages",
    detail: "Test templates, text, broadcasts and scheduled sends. These are real messages to real people, and Meta bills them.",
  },
  {
    scope: "eccos:configure",
    title: "Configure the workspace",
    detail: "Templates, the webhook configuration, resubscribing, re-checking a number and phone settings.",
  },
  {
    scope: "eccos:administer",
    title: "Administer the workspace",
    detail:
      "The connection link, API keys, checkout and billing state. An agent may ask for an API key to be shown to it inline.",
  },
];

/** The scopes of a requested `scope` string the person chooses among, and whether a refresh token was asked for. */
export function requestedScopes(scope: string): { choices: ScopeCopy[]; offlineAccess: boolean } {
  const requested = new Set(scope.split(" ").filter(Boolean));
  return {
    choices: SCOPE_COPY.filter((copy) => requested.has(copy.scope)),
    offlineAccess: requested.has(OFFLINE_ACCESS),
  };
}
