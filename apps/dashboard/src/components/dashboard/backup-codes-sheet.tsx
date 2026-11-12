import { useSyncExternalStore } from "react";
import { heldBackupCodes, subscribeBackupCodes } from "../../lib/backup-codes";
import { BackupCodes } from "./two-factor";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Backup codes right after an enrollment, wherever it happened. Mounted once
 * in the shell, above every dialog, and closed only by Done: the codes cannot
 * be shown again.
 */
export function BackupCodesSheet() {
  const held = useSyncExternalStore(subscribeBackupCodes, heldBackupCodes, () => null);
  return (
    <Sheet open={held !== null} disablePointerDismissal onOpenChange={() => {}}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-2 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="gap-2">
          <SheetTitle>Save your backup codes</SheetTitle>
          <SheetDescription>
            Two-factor authentication is on. What you were doing continues once these are saved.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          {held ? <BackupCodes codes={held.codes} onDone={held.confirm} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
