import React from "react";
import { createRoot } from "react-dom/client";
import { AppShellV2 } from "./v2/AppShellV2";
import { DashboardEntry } from "./brief/entry/DashboardEntry";
import "./styles/globals.css";

const root = createRoot(document.getElementById("root")!);
root.render(<DashboardEntry legacy={<AppShellV2 />} />);
