export function Logo() {
  return (
    <>
      <img
        src="/assets/logomark-light.png"
        alt=""
        width="24"
        height="24"
        className="size-6 shrink-0 object-contain dark:hidden"
      />
      <img
        src="/assets/logomark.png"
        alt=""
        width="24"
        height="24"
        className="hidden size-6 shrink-0 object-contain dark:block"
      />
    </>
  )
}
