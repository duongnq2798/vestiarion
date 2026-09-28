/**
 * Shown the moment a section link is followed, while the page gathers its
 * data; the navigation around it stays in place. Same frame and spacing as
 * `ProductShell`, so the page lands without a jump.
 */
export default function WorkspaceLoading() {
  const block = "rounded-lg bg-raised/80 motion-safe:animate-pulse";
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <p role="status" className="sr-only">Loading…</p>
      <div className="mb-6 flex flex-wrap gap-2">
        <div className={`h-7 w-20 rounded-full ${block}`} />
        <div className={`h-7 w-48 rounded-full ${block}`} />
      </div>
      <div className="mb-8 border-b border-line pb-6">
        <div className={`h-8 w-44 ${block}`} />
        <div className={`mt-3 h-4 w-full max-w-xl ${block}`} />
      </div>
      <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className="surface-shadow h-28 rounded-xl border border-line bg-surface p-4">
            <div className={`h-3 w-24 ${block}`} />
            <div className={`mt-4 h-6 w-32 ${block}`} />
          </div>
        ))}
      </div>
      <div className="space-y-4">
        {[0, 1].map((card) => (
          <div key={card} className="surface-shadow rounded-xl border border-line bg-surface p-5">
            <div className={`h-3 w-40 ${block}`} />
            <div className={`mt-3 h-5 w-3/5 ${block}`} />
            <div className={`mt-5 h-4 w-full ${block}`} />
            <div className={`mt-2 h-4 w-4/5 ${block}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
