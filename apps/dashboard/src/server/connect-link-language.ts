import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { pickLanguage } from "../lib/connect-link/language";

/** The landing page's language, from the request that loads it. Reads nothing else. */
export const getConnectLinkLanguage = createServerFn({ method: "GET" }).handler(() =>
  pickLanguage(getRequest().headers.get("accept-language")),
);
