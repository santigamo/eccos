import { SUPPORT_EMAIL } from "../../lib/support";

const SUPPORT_PHRASE = /(contact Eccos support)/i;

/** Copy from `lib/provisioning-copy.ts`, with its support phrase linked. */
export function SupportText({ children }: { children: string }) {
  return children.split(SUPPORT_PHRASE).map((part, index) =>
    index % 2 === 1 ? (
      <a
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed sentence
        key={index}
        href={`mailto:${SUPPORT_EMAIL}`}
        className="text-ink underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}
