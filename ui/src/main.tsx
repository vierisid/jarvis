import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppShellV2 } from "./v2/AppShellV2";
import { isV2Enabled } from "./v2/flag";
import "./styles/globals.css";

const root = createRoot(document.getElementById("root")!);
root.render(isV2Enabled() ? <AppShellV2 /> : <App />);
