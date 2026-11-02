"use client"

import type { CSSProperties } from "react"
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Sonner's stylesheet is unlayered, so it beats Tailwind's utilities layer:
// its own variables carry the tokens, and any override takes `!`.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4 text-[#f0a020]" />,
        error: <OctagonXIcon className="size-4 text-[#ff7777]" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          fontFamily: "var(--font-sans)",
          "--normal-bg": "var(--popover)",
          "--normal-bg-hover": "var(--accent)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--line-strong)",
          "--normal-border-hover": "var(--ghost-edge-hover)",
          "--border-radius": "0",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          closeButton:
            "rounded-none! bg-(--popover)! border-(--line-strong)! hover:bg-(--popover)! hover:border-(--ghost-edge-hover)! focus-visible:shadow-none! focus-visible:outline-2! focus-visible:outline-offset-2! focus-visible:outline-ring!",
          warning: "border-l-2! border-l-[#f0a020]!",
          error: "border-l-2! border-l-[#e03131]!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
