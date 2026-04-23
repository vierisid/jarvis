import React from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

export type IconSize = "sm" | "md" | "lg";

const SIZE_PX: Record<IconSize, number> = {
  sm: 14,
  md: 16,
  lg: 20,
};

export interface IconProps extends Omit<LucideProps, "size"> {
  icon: LucideIcon;
  size?: IconSize | number;
  label?: string;
}

export function Icon({
  icon: LucideIconComponent,
  size = "md",
  strokeWidth = 1.75,
  className,
  label,
  ...rest
}: IconProps) {
  const px = typeof size === "number" ? size : SIZE_PX[size];
  const classes = ["v2-icon", className].filter(Boolean).join(" ");
  const a11y = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true };

  return (
    <LucideIconComponent
      size={px}
      strokeWidth={strokeWidth}
      className={classes}
      {...a11y}
      {...rest}
    />
  );
}
