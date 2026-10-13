"use client";

import { Field } from "@/components/ui/Field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

/**
 * The project field on Bill to pay and Add milestone (docs/superpowers/specs/2026-10-13-project-budgets-design.md P3):
 * optional, and shown only when the workspace has an active project. The money of what is added is set aside in the
 * project's budget as it is added, when the budget holds it. "No project" sends no id. Free of server actions, so the
 * forms that hold it import nothing more.
 */
export function ProjectSelectField({ projects, id, className }: { projects: Array<{ id: string; name: string }> | null | undefined; id: string; className?: string }) {
  if (!projects || projects.length === 0) return null;
  return (
    <Field id={id} label="Project" optional description="Its money is set aside in the project's budget as it is added." className={className}>
      <Select name="projectId" defaultValue="none">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No project</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
