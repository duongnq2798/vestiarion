import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Real radio buttons and a real checkbox, for a form a server page posts to a route (the connect pages): no JavaScript,
 * so they work before the page's has loaded, or without it. Clicking a label picks its input, the keyboard moves and
 * ticks them as in any form, `required` is the browser's own, and what is ticked is what is posted. They look like
 * `RadioGroup` and `Checkbox`, which a client form keeps for its controlled state.
 *
 * Ids come from `name` and each value, so give each group a name no other control on the page has.
 */

const idOf = (...parts: string[]) => `choice-${parts.join("-").replace(/[^A-Za-z0-9_-]/g, "_")}`;

const BOX =
  "peer absolute inset-0 size-5 cursor-pointer appearance-none border border-line-strong bg-surface shadow-control transition-colors duration-150 ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agent disabled:cursor-not-allowed";

export interface NativeRadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
}

/** One choice among a few, in a fieldset named by its legend; `defaultValue` is the one picked when the page opens. */
export function NativeRadioGroup({
  legend,
  name,
  options,
  defaultValue,
  required,
  className,
}: {
  legend: ReactNode;
  name: string;
  options: readonly NativeRadioOption[];
  defaultValue?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={className}>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <div className="mt-3 grid gap-3">
        {options.map((option) => {
          const id = idOf(name, option.value);
          const descriptionId = option.description ? `${id}-description` : undefined;
          return (
            <div key={option.value} className="flex items-start gap-3 has-[:disabled]:opacity-60">
              <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
                <input
                  type="radio"
                  id={id}
                  name={name}
                  value={option.value}
                  defaultChecked={option.value === defaultValue}
                  required={required}
                  aria-describedby={descriptionId}
                  className={cn(BOX, "rounded-full checked:border-agent")}
                />
                <span
                  aria-hidden
                  className="pointer-events-none relative size-2.5 scale-50 rounded-full bg-agent opacity-0 transition duration-150 ease-standard peer-checked:scale-100 peer-checked:opacity-100"
                />
              </span>
              <div className="grid gap-0.5">
                <label htmlFor={id} className="cursor-pointer text-sm leading-6 text-ink">
                  {option.label}
                </label>
                {option.description && (
                  <p id={descriptionId} className="text-xs text-ink-3">
                    {option.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A checkbox with its label; ticked, it posts `name=value`. */
export function NativeCheckbox({
  name,
  value,
  label,
  description,
  required,
  defaultChecked,
  className,
}: {
  name: string;
  value: string;
  label: ReactNode;
  description?: ReactNode;
  required?: boolean;
  defaultChecked?: boolean;
  className?: string;
}) {
  const id = idOf(name, value);
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cn("flex items-start gap-3 has-[:disabled]:opacity-60", className)}>
      <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
        <input
          type="checkbox"
          id={id}
          name={name}
          value={value}
          defaultChecked={defaultChecked}
          required={required}
          aria-describedby={descriptionId}
          className={cn(BOX, "rounded-md checked:border-agent checked:bg-agent")}
        />
        <Check
          aria-hidden
          strokeWidth={3}
          className="pointer-events-none relative size-3.5 text-on-agent opacity-0 transition-opacity duration-150 ease-standard peer-checked:opacity-100"
        />
      </span>
      <div className="grid gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm leading-6 text-ink">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-xs text-ink-3">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
