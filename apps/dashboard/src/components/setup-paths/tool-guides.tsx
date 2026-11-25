import type { ReactNode } from "react";
import { CodeXmlIcon, PlugIcon } from "lucide-react";
import type { Choice } from "./choice-list";

export type Tool = "make" | "n8n" | "zapier" | "other";

export const TOOLS: Choice<Tool>[] = [
  { id: "make", icon: PlugIcon, title: "Make", detail: "You build scenarios by joining blocks, with no code." },
  { id: "n8n", icon: PlugIcon, title: "n8n", detail: "You build workflows, in the cloud or on your own server." },
  { id: "zapier", icon: PlugIcon, title: "Zapier", detail: "You build Zaps that join your apps together." },
  {
    id: "other",
    icon: CodeXmlIcon,
    title: "My own system, or another tool",
    detail: "Anything that can receive data at a web address. Your developer will know.",
  },
];

const B = ({ children }: { children: ReactNode }) => <span className="font-semibold">{children}</span>;

export type ToolGuide = {
  /** How the copy names it: "Make", "your tool". */
  name: string;
  /** What the address belongs to there: a scenario, a workflow, a Zap. */
  owner: string;
  /** The clicks in the tool that end with its address copied. */
  steps: { text: ReactNode; note?: ReactNode }[];
  placeholder: string;
  /** What keeps it listening during the test. */
  listen: ReactNode;
  /** The first fix when it refused. */
  fix: ReactNode;
};

/** Make in detail; the others say the same in their own words. */
export const GUIDES: Record<Tool, ToolGuide> = {
  make: {
    name: "Make",
    owner: "scenario",
    steps: [
      { text: "In Make, create a new scenario." },
      {
        text: (
          <>
            Add the module called <B>Webhooks</B>, then choose <B>Custom webhook</B>.
          </>
        ),
      },
      {
        text: (
          <>
            Click <B>Add</B>, give it any name, then click <B>Copy address to clipboard</B>.
          </>
        ),
        note: (
          <>
            Make shows a link that starts with <span className="font-mono text-xs">https://hook</span>. That link is the
            address.
          </>
        ),
      },
    ],
    placeholder: "https://hook.eu2.make.com/…",
    listen: (
      <>
        Keep Make open and click <span className="font-medium text-foreground">Run once</span> so it listens.
      </>
    ),
    fix: (
      <>
        In Make, check the scenario is on, or click <B>Run once</B>.
      </>
    ),
  },
  n8n: {
    name: "n8n",
    owner: "workflow",
    steps: [
      { text: "In n8n, create a new workflow." },
      {
        text: (
          <>
            Add the <B>Webhook</B> trigger and set its HTTP method to <B>POST</B>.
          </>
        ),
      },
      { text: <>Copy its <B>Production URL</B>.</>, note: "Then turn the workflow on, so the address answers." },
    ],
    placeholder: "https://…/webhook/…",
    listen: "Keep the workflow turned on so it listens.",
    fix: (
      <>
        In n8n, check the workflow is on and you copied the <B>Production URL</B>.
      </>
    ),
  },
  zapier: {
    name: "Zapier",
    owner: "Zap",
    steps: [
      { text: "In Zapier, create a new Zap." },
      {
        text: (
          <>
            For the trigger, choose <B>Webhooks by Zapier</B>, then <B>Catch Hook</B>.
          </>
        ),
      },
      {
        text: (
          <>
            Click <B>Continue</B> and copy the webhook URL.
          </>
        ),
        note: (
          <>
            It starts with <span className="font-mono text-xs">https://hooks.zapier.com</span>.
          </>
        ),
      },
    ],
    placeholder: "https://hooks.zapier.com/hooks/catch/…",
    listen: (
      <>
        Keep Zapier open on <span className="font-medium text-foreground">Test trigger</span>.
      </>
    ),
    fix: "In Zapier, check the Zap is published, or open its trigger test again.",
  },
  other: {
    name: "your system",
    owner: "system",
    steps: [
      { text: "Ask your developer for the web address where your system receives data." },
      { text: "It must accept a POST with JSON and answer with a 2xx status." },
    ],
    placeholder: "https://",
    listen: "Your system must be running and reachable from the internet.",
    fix: "Check your system is running and answers a POST at that address.",
  },
};
