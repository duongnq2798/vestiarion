import { revalidatePath } from "next/cache";

/** Everything under an organization's layout, on its next visit. */
export function revalidateOrgPages(): void {
  revalidatePath("/o/[slug]", "layout");
}
