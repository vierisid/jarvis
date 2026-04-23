import React from "react";

export interface KBDProps extends React.HTMLAttributes<HTMLElement> {}

export function KBD({ className, children, ...rest }: KBDProps) {
  const classes = ["v2-kbd", className].filter(Boolean).join(" ");
  return (
    <kbd className={classes} {...rest}>
      {children}
    </kbd>
  );
}
