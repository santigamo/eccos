import { INLINE_LINK } from "../../ui";

const SUPPORT_PHRASE = /(contact Eccos support)/i;

/**
 * Copy from `lib/provisioning-copy.ts`, with its support phrase linked to the
 * deployment's `SUPPORT_EMAIL`. A self-host that sets none gets the plain sentence.
 */
export function SupportText({ children, email }: { children: string; email?: string | null }) {
  if (!email) return children;
  return children.split(SUPPORT_PHRASE).map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed sentence
      <a key={index} href={`mailto:${email}`} className={INLINE_LINK}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
