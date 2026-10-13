import type { OrgDb } from "../dal";
import type { ProjectRoomNow } from "../agent/follow-up";
import { projectsNotReady } from "./reserve";

/**
 * What the projects of some held bills or milestones have left to set aside now (project budgets P6), for the follow-up
 * stage: the budget, less its buffer, less what is reserved and paid, counted by migration 0111's `project_figures` as
 * the reservation counts it. Best effort: a read that fails reopens nothing, and the payment stays held.
 */
export async function projectRoomsFor(orgDb: OrgDb, table: "invoices" | "milestones", ids: readonly string[]): Promise<Map<string, ProjectRoomNow>> {
  const rooms = new Map<string, ProjectRoomNow>();
  if (ids.length === 0) return rooms;
  try {
    const rows = await orgDb.from(table).select("id, project_id").in("id", [...ids]);
    if (projectsNotReady(rows.error)) return rooms;
    if (rows.error) throw new Error(rows.error.message);
    const members = (rows.data ?? []) as unknown as Array<{ id: string; project_id: string | null }>;
    const projectIds = [...new Set(members.flatMap((row) => (row.project_id ? [row.project_id] : [])))];
    const available = new Map<string, number | null>();
    if (projectIds.length > 0) {
      const [projects, figures] = await Promise.all([
        orgDb.from("projects").select("id, budget_minor, buffer_minor, status").in("id", projectIds),
        orgDb.rpc("project_figures"),
      ]);
      if (projects.error) throw new Error(projects.error.message);
      if (figures.error) throw new Error(figures.error.message);
      const committed = new Map(
        ((figures.data ?? []) as Array<{ project_id: string; reserved_minor: number | string; paid_minor: number | string }>).map((row) => [
          row.project_id,
          Number(row.reserved_minor) + Number(row.paid_minor),
        ])
      );
      for (const project of (projects.data ?? []) as unknown as Array<{ id: string; budget_minor: number | string; buffer_minor: number | string; status: string }>) {
        available.set(
          project.id,
          project.status === "active" ? Number(project.budget_minor) - Number(project.buffer_minor) - (committed.get(project.id) ?? 0) : null
        );
      }
    }
    for (const row of members) {
      rooms.set(row.id, { projectId: row.project_id, availableMinor: row.project_id ? (available.get(row.project_id) ?? null) : null });
    }
    return rooms;
  } catch (error) {
    console.error("project rooms not read", table, error instanceof Error ? error.message : error);
    return new Map();
  }
}
