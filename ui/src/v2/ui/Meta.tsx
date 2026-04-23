import React from "react";

export interface MetaProps extends React.HTMLAttributes<HTMLSpanElement> {
  inline?: boolean;
  as?: "span" | "div" | "time";
  dateTime?: string;
}

export function Meta({
  inline,
  as: Tag = "span",
  className,
  children,
  dateTime,
  ...rest
}: MetaProps) {
  const classes = ["v2-meta", inline && "v2-meta--inline", className].filter(Boolean).join(" ");
  const extraProps = dateTime && Tag === "time" ? { dateTime } : {};
  return (
    <Tag className={classes} {...extraProps} {...rest}>
      {children}
    </Tag>
  );
}
