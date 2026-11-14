"use client";

import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./Button";

export type NativeSubmitButtonProps = Omit<ButtonProps, "type" | "asChild" | "loading">;

/**
 * The submit button of a form the browser sends itself (`method="post"` to a route that redirects, such as to an
 * integration's consent screen), where no action reports that it is pending. Once its form is sent it is busy and takes
 * no second press, until another page replaces this one; coming back to this page with the browser's Back button finds
 * it ready again.
 */
export function NativeSubmitButton(props: NativeSubmitButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    // The browser fires submit only for a form that passed its own checks, after which nothing can stop it but a
    // handler; one that stopped it leaves the button as it was.
    const onSubmit = (event: SubmitEvent) => {
      if (!event.defaultPrevented) setSent(true);
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setSent(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  return <Button ref={ref} type="submit" loading={sent} {...props} />;
}
