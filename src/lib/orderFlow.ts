// URLs for the deploy flow (plan → configure → checkout → provisioning).
// Choices live in the query string so every step can link back without
// losing what the user picked.

import type { CycleKey } from "@/lib/pricing";

export type FlowChoices = {
  cycle: CycleKey;
  addons?: string[];
  hostname?: string;
  stack?: string;
  os?: string;
};

function flowQuery({ cycle, addons, hostname, stack, os }: FlowChoices): string {
  const q = new URLSearchParams({ cycle });
  if (addons?.length) q.set("addons", addons.join(","));
  if (hostname) q.set("hostname", hostname);
  if (stack) q.set("stack", stack);
  if (os) q.set("os", os);
  return q.toString();
}

export const planStepHref = (slug: string, choices: FlowChoices) => `/order/${slug}?${flowQuery(choices)}`;

export const configureStepHref = (slug: string, choices: FlowChoices) =>
  `/order/${slug}/configure?${flowQuery(choices)}`;
