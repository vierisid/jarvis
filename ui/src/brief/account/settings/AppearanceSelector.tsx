import React from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import { BriefSegments } from "../../components/controls";
/** Every mounted selector subscribes directly to the existing appearance owner. */
export function AppearanceSelector() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="brief-settings-appearance">
      <span>Appearance</span>
      <BriefSegments
        label="Appearance"
        value={theme}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        onValueChange={(v) => setTheme(v as "light" | "dark")}
      />
    </div>
  );
}
