import React from "react";
import { createRoot } from "react-dom/client";
import { Pebble } from "./Pebble";
import "./pebble.css";

// In production the daemon spawns the pebble in a transparent native window
// and adds `?native=1` to the URL. Otherwise we're in browser dev mode and
// need a backdrop so the pebble is visible against something.
const params = new URLSearchParams(window.location.search);
if (params.get("native") !== "1") {
  document.body.classList.add("pebble-dev-backdrop");
}

const root = createRoot(document.getElementById("pebble-root")!);
root.render(<Pebble />);
