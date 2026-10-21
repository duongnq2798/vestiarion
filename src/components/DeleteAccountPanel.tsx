"use client";

import { Trash2 } from "lucide-react";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { Button } from "@/components/ui/Button";
import { SectionHeader } from "@/components/ui/SectionHeader";

/**
 * "Delete account" in a danger zone (docs/superpowers/specs/2026-10-21-delete-account-in-settings-design.md DA2, DA3):
 * at the end of Settings and of /account, never in the account menu. It needs no workspace role, so every signed-in
 * person gets it; the dialog says what happens before anything does.
 */
export default function DeleteAccountPanel() {
  return (
    <section aria-labelledby="delete-account-title">
      <SectionHeader id="delete-account-title" title="Delete account" />
      <div className="space-y-4 rounded-xl border border-refused-line p-5">
        <p className="text-sm leading-relaxed text-ink-2">
          Deletes your sign-in and takes you out of every workspace. A workspace where you are the only member is deleted with it: the dialog lists each one first. It cannot be undone.
        </p>
        <DeleteAccountDialog
          trigger={
            <Button variant="danger" icon={<Trash2 />}>
              Delete account
            </Button>
          }
        />
      </div>
    </section>
  );
}
