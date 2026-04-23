import React from "react";

export interface RuleProps extends React.HTMLAttributes<HTMLHRElement> {
  bold?: boolean;
}

export function Rule({ bold, className, ...rest }: RuleProps) {
  const classes = ["v2-rule", bold && "v2-rule--bold", className].filter(Boolean).join(" ");
  return <hr className={classes} {...rest} />;
}
