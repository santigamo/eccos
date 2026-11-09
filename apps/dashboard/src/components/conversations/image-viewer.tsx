import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";

/** A received image at near-full size. Escape and an outside press close it (the Dialog's own). */
export function ImageViewer({
  src,
  alt,
  open,
  onOpenChange,
}: {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-[min(92vw,80rem)]">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img src={src} alt={alt} className="max-h-[78vh] w-auto max-w-full object-contain mx-auto" />
        <DialogFooter>
          <a href={src} download className="underline underline-offset-4 text-sm">
            Download
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
