import React from "react";

export type ChipTone = "neutral" | "ok" | "warn" | "accent";

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  dot?: boolean;
}

export function Chip({
  tone = "neutral",
  dot = true,
  className,
  children,
  ...rest
}: ChipProps) {
  const classes = ["v2-chip", `v2-chip--${tone}`, className].filter(Boolean).join(" ");

  return (
    <span className={classes} {...rest}>
      {dot && <span className="v2-chip__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
