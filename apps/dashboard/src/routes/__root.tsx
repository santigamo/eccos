import type { CSSProperties, ReactNode } from "react";
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Eccos — Operator Console" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Nav />
      <Outlet />
    </RootDocument>
  );
}

const NAV_LINKS = [
  { to: "/", label: "Status", exact: true },
  { to: "/deliveries", label: "Deliveries", exact: false },
  { to: "/inbound", label: "Inbound", exact: false },
  { to: "/outbound", label: "Outbound", exact: false },
  { to: "/templates", label: "Templates", exact: false },
] as const;

function Nav() {
  return (
    <nav style={navStyles.bar}>
      <div style={navStyles.inner}>
        <span style={navStyles.brand}>eccos</span>
        <div style={navStyles.links}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              activeOptions={{ exact: link.exact }}
              style={navStyles.link}
              activeProps={{ style: navStyles.linkActive }}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}

const navStyles = {
  bar: {
    borderBottom: "1px solid #1d2531",
    background: "#0d1119",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  inner: {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "0 20px",
    display: "flex",
    alignItems: "center",
    gap: 24,
    height: 48,
  },
  brand: {
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontSize: 13,
    color: "#e6e9ef",
  },
  links: { display: "flex", gap: 4, flexWrap: "wrap" },
  link: {
    color: "#7a8290",
    textDecoration: "none",
    padding: "6px 10px",
    borderRadius: 6,
    fontSize: 13,
  },
  linkActive: { color: "#e6e9ef", background: "#1d2531" },
} satisfies Record<string, CSSProperties>;

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0b0e14",
          color: "#e6e9ef",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {children}
        <Scripts />
      </body>
    </html>
  );
}
