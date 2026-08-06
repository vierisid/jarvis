import React from "react";
import { createRoot } from "react-dom/client";
import { AppShellV2 } from "./v2/AppShellV2";
import { I18nProvider } from "./v2/i18n/I18nProvider";
import "./styles/globals.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <I18nProvider>
    <AppShellV2 />
  </I18nProvider>,
);
