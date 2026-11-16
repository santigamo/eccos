// Tells Bing (and the other IndexNow engines) which pages changed in the last
// two days, read from the built sitemap. Runs after `wrangler deploy`.
import { readFileSync } from "node:fs";

const KEY = "9a2c2670c1009f897faf1122b34edaa2";
const HOST = "eccos.chat";
const since = Date.now() - 2 * 86_400_000;

const sitemap = readFileSync(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)]
  .filter(([, , lastmod]) => !lastmod || Date.parse(lastmod) >= since)
  .map(([, loc]) => loc);

if (urlList.length === 0) {
  console.log("indexnow: nothing changed");
} else {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
  });
  console.log(`indexnow: ${res.status} for ${urlList.length} URLs`);
}
