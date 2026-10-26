import React from "react";
import { createRoot } from "react-dom/client";
import { DashboardRoot } from "./brief/host/DashboardRoot";
import "./styles/globals.css";

const root = createRoot(document.getElementById("root")!);
root.render(<DashboardRoot />);
