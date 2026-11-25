/** Does `pathname` belong to `route`, where a `$param` segment stands for one real path segment? */
export function matchesRoute(route: string, pathname: string): boolean {
  if (route === pathname) return true;
  return route.includes("$") && new RegExp(`^${route.replace(/\$[^/]+/g, "[^/]+")}$`).test(pathname);
}
