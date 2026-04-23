import React from "react";
import { useV2Route } from "./router";
import { AppShell } from "./shell/AppShell";
import { PrimitivesPage } from "./pages/PrimitivesPage";
import "./v2.css";
import "./ui/primitives.css";

export function AppShellV2() {
  const route = useV2Route();

  return (
    <div className="jarvis-v2-root">
      {route === "primitives" ? <PrimitivesPage /> : <AppShell />}
    </div>
  );
}
