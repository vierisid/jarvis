import React from "react";

export function UserProfilePanel() {
  return (
    <div style={cardStyle}>
      <h3 style={titleStyle}>User Profile</h3>
      <p style={textStyle}>
        Profile controls are not available in this branch snapshot yet.
      </p>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "20px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: "8px",
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--j-text)",
};

const textStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "var(--j-text-muted)",
  lineHeight: 1.5,
};
