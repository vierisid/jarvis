import React from "react";
import light from "./assets/usejarvis-light.svg";
import dark from "./assets/usejarvis-dark.svg";

/** Official lockup, including its embedded font. Do not redraw the mark. */
export function BriefBrand() {
  return <span className="brief-brand" role="img" aria-label="usejarvis">
    <img className="brief-brand__light" src={light} alt="" width="515.7" height="143.9" />
    <img className="brief-brand__dark" src={dark} alt="" width="515.7" height="143.9" />
  </span>;
}
