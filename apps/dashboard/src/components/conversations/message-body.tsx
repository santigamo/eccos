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
            <a href={src} download={filename} className="underline underline-offset-4">
              {filename}
            </a>
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
    default:
      return text ? <p className="whitespace-pre-wrap">{text}</p> : <p className="text-muted-foreground">{message.type}</p>;
  }
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
  return (
    <img
      src={src}
      alt={kind === "sticker" ? "Sticker" : "Image"}
      loading="lazy"
      onError={onError}
      className="max-h-72 max-w-full border border-(--line)"
    />
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
