"use client";

import { CircleAlert } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";

export interface FieldState {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldState | null>(null);

/** The ids of the Field a control sits in, or null outside one. */
export function useField(): FieldState | null {
  return useContext(FieldContext);
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: ComponentProps<"input">["aria-invalid"] };

/** What a control takes from the Field around it — unless it was given its own. */
export function useFieldControl(props: ControlProps) {
  const field = useField();
  return {
    id: props.id ?? field?.id,
    "aria-describedby": props["aria-describedby"] ?? field?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid ? true : undefined),
  };
}

export interface FieldProps {
  /** The control’s id: the label points at it and the description and error hang off it. */
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A labelled control. The one control inside takes its id and
 * `aria-describedby` from here, so a description or an error is always
 * announced with the field it belongs to.
 */
export function Field({ id, label, description, error, optional = false, className, children }: FieldProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      <div className={cn("grid content-start gap-1.5", className)}>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
          {optional && <span className="ml-1 font-normal text-ink-3">(optional)</span>}
        </label>
        {children}
        {description && (
          <p id={descriptionId} className="text-xs leading-relaxed text-ink-3">
            {description}
          </p>
        )}
        {error && (
          <p id={errorId} className="flex items-start gap-1.5 text-xs font-medium text-refused">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
