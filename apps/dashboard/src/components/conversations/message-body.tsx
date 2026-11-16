import { useState } from "react";

import {
  contactsOf,
  errorCodeOf,
  locationOf,
  mediaFilenameOf,
  mediaIdOf,
  mediaSrc,
  reactionEmojiOf,
  type ThreadEntry,
} from "../../lib/conversations";
import { templateMessageOf } from "../../lib/template-message";
import { ImageViewer } from "./image-viewer";

/**
 * What one message SAYS, by its type. Every type the gateway stores has a
 * reading here; a type it does not know shows its own name, never a blank.
 */
export function MessageBody({ entry, wabaId }: { entry: ThreadEntry; wabaId?: string }) {
  const { message, text } = entry;
  if (entry.deleted) return <p className="text-muted-foreground">Message deleted</p>;

  switch (message.type) {
    case "image":
    case "sticker":
    case "audio":
    case "video":
      return (
        <>
          <MediaFile kind={message.type} src={mediaSrc(wabaId, mediaIdOf(message))} />
          <Caption text={text} />
        </>
      );
    case "document": {
      const src = mediaSrc(wabaId, mediaIdOf(message));
      const filename = mediaFilenameOf(message) ?? "Document";
      return (
        <>
          {src ? (
            <>
              <a href={src} download={filename} className="underline underline-offset-4">
                {filename}
              </a>
              <span className="block text-xs text-muted-foreground">May be unavailable: not downloaded yet, or expired.</span>
            </>
          ) : (
            <MediaUnavailable />
          )}
          <Caption text={text} />
        </>
      );
    }
    case "location": {
      const location = locationOf(message);
      if (!location) return <p>Location</p>;
      return (
        <>
          <p className="font-medium">{location.name ?? "Location"}</p>
          {location.address ? <p className="text-muted-foreground">{location.address}</p> : null}
          <a
            href={location.mapHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Open in maps
          </a>
        </>
      );
    }
    case "contacts":
      return (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {contactsOf(message).map((contact) => (
            <li key={`${contact.name}:${contact.phones.join(",")}`}>
              <p>{contact.name}</p>
              {contact.phones.map((phone) => (
                <p key={phone} className="font-mono text-xs text-muted-foreground">
                  {phone}
                </p>
              ))}
            </li>
          ))}
        </ul>
      );
    case "reaction": {
      // Reached only when the reacted message is not in the page; otherwise the
      // reaction is drawn on that message (see `threadEntries`).
      const emoji = reactionEmojiOf(message);
      return <p>{emoji ? `Reacted ${emoji} to a message` : "Removed a reaction"}</p>;
    }
    case "edit":
      // Reached only when the edited message is not in the page; the new text is all there is.
      return <p>{text ?? "Edited message"}</p>;
    case "revoke":
      return <p className="text-muted-foreground">Message deleted</p>;
    case "unsupported": {
      const code = errorCodeOf(message);
      return (
        <>
          <p>Unsupported message</p>
          {code ? <p className="text-xs text-muted-foreground">Error code {code}</p> : null}
        </>
      );
    }
    case "media_placeholder":
      return <MediaUnavailable />;
    case "template":
      return <TemplateBody entry={entry} />;
    default:
      return text ? <p className="whitespace-pre-wrap">{text}</p> : <p className="text-muted-foreground">{message.type}</p>;
  }
}

/** With its copy, the words the customer read; without it, the values sent by slot, never today's template. */
function TemplateBody({ entry }: { entry: ThreadEntry }) {
  const { name, copy, values } = templateMessageOf(entry.message);
  return (
    <>
      <p className="mb-1 text-[11px] text-muted-foreground">
        <span className="font-medium tracking-wider uppercase">Template</span>
        {name ? <span className="font-mono"> · {name}</span> : null}
      </p>
      {copy ? (
        <>
          {copy.header ? <p className="font-medium whitespace-pre-wrap">{copy.header}</p> : null}
          <p className="whitespace-pre-wrap">{copy.body}</p>
          {copy.footer ? <p className="mt-1 text-xs text-muted-foreground">{copy.footer}</p> : null}
          {copy.buttons ? (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {copy.buttons.map((label, index) => (
                <li key={`${index}:${label}`} className="border border-border px-2 py-1 text-center text-sm">
                  {label}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : values.length > 0 ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          {values.map((value) => (
            <div key={value.slot} className="contents">
              <dt className="font-mono text-xs text-muted-foreground">{value.slot}</dt>
              <dd className={`m-0 ${value.mono ? "font-mono text-xs break-all" : "whitespace-pre-wrap"}`}>{value.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">This send filled no parameters.</p>
      )}
    </>
  );
}

function Caption({ text }: { text: string | null }) {
  return text ? <p className="mt-2 whitespace-pre-wrap">{text}</p> : null;
}

/**
 * The file itself, read from the console's media route. A 404 (not downloaded
 * yet, or expired) swaps in the same fallback as a message with no media id,
 * so the bubble keeps its caption and its place in the thread.
 */
function MediaFile({
  kind,
  src,
}: {
  kind: string;
  src: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [viewing, setViewing] = useState(false);
  if (!src || failed) return <MediaUnavailable />;
  const onError = () => setFailed(true);
  // Customer media arrives without a caption track; its text caption sits beside the player.
  if (kind === "audio") {
    // biome-ignore lint/a11y/useMediaCaption: no caption track exists for customer media
    return <audio controls preload="none" src={src} aria-label="Audio message" onError={onError} className="w-full max-w-xs" />;
  }
  if (kind === "video") {
    // biome-ignore lint/a11y/useMediaCaption: no caption track exists for customer media
    return <video controls preload="metadata" src={src} aria-label="Video message" onError={onError} className="max-h-72 max-w-full" />;
  }
  if (kind === "sticker") {
    return <img src={src} alt="Sticker" loading="lazy" onError={onError} className="block max-h-40 w-auto max-w-full object-contain" />;
  }
  // The placeholder holds the bubble's room until the picture has loaded, then drops away.
  return (
    <>
      <button
        type="button"
        aria-label="Open image"
        onClick={() => setViewing(true)}
        className="block cursor-zoom-in outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <img
          src={src}
          alt="Attachment from this conversation"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={onError}
          className={`block max-h-96 w-auto max-w-full object-contain ${loaded ? "" : "min-h-24 min-w-40 bg-muted/40"}`}
        />
      </button>
      <ImageViewer src={src} alt="Attachment from this conversation" open={viewing} onOpenChange={setViewing} />
    </>
  );
}

function MediaUnavailable() {
  return (
    <p className="text-muted-foreground">
      Media not available
      <span className="block text-xs">Not downloaded yet, or expired.</span>
    </p>
  );
}
