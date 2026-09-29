import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Shown the moment a section link is followed, while the page gathers its
 * data; the navigation around it stays in place. Same frame and spacing as
 * `ProductShell`, so the page lands without a jump.
 */
export default function WorkspaceLoading() {
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8">
      <p role="status" className="sr-only">
        Loading…
      </p>
      <div className="mb-6 flex flex-wrap gap-2">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-48 rounded-full" />
      </div>
      <div className="mb-8 border-b border-line pb-6">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      </div>
      <div className="mb-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Card key={tile} className="h-28 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-6 w-32" />
          </Card>
        ))}
      </div>
      <div className="space-y-4">
        {[0, 1].map((card) => (
          <Card key={card} className="p-5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-3 h-5 w-3/5" />
            <Skeleton className="mt-5 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
          </Card>
        ))}
      </div>
    </div>
  );
}
