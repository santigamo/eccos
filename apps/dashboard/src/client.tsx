import * as Sentry from "@sentry/react";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { sentryOptions } from "./lib/sentry";
import { installTranslateGuard } from "./lib/translate-guard";

// TanStack Start's default client entry, plus Sentry and the translate guard.
Sentry.init(sentryOptions);
installTranslateGuard();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    { onUncaughtError: Sentry.reactErrorHandler(), onCaughtError: Sentry.reactErrorHandler() },
  );
});
