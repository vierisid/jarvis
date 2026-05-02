import React from "react";
import { createRoot } from "react-dom/client";
import { Pebble } from "./Pebble";
import "./pebble.css";

const root = createRoot(document.getElementById("pebble-root")!);
root.render(<Pebble />);
