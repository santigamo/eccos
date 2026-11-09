import { SunMoonIcon } from "lucide-react"

import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { setThemeMode, useTheme, type ThemeMode } from "@/lib/theme"

const CHOICES: { mode: ThemeMode; label: string }[] = [
  { mode: "auto", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
]

/**
 * The theme choice as a submenu row. It renders its own trigger and items, so
 * it mounts inside any dropdown: the host only places `<ThemeMenu />`.
 */
export function ThemeMenu() {
  const { mode } = useTheme()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <SunMoonIcon aria-hidden="true" />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={mode} onValueChange={(next: ThemeMode) => setThemeMode(next)}>
          {CHOICES.map(({ mode: value, label }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
