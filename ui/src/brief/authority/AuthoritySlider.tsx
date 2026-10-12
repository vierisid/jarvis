import React, { useEffect, useRef, useState, type CSSProperties } from "react";

const clamp = (value: number) => Math.min(10, Math.max(1, value));
/** Native range semantics, with continuous pointer position and integer release/keyboard values. */
export function AuthoritySlider({
  value,
  disabled,
  onChange,
  beginInteraction,
  endInteraction,
}: {
  value: number;
  disabled: boolean;
  onChange(value: number): void;
  beginInteraction(): boolean;
  endInteraction(): void;
}) {
  const [position, setPosition] = useState(value),
    [dragging, setDragging] = useState(false);
  const active = useRef(false),
    start = useRef(value),
    positionRef = useRef(value);
  const move = (next: number) => {
    positionRef.current = next;
    setPosition(next);
  };
  useEffect(() => {
    if (disabled) {
      active.current = false;
      setDragging(false);
      endInteraction();
    }
    if (!active.current) move(value);
  }, [value, disabled, endInteraction]);
  useEffect(() => endInteraction, [endInteraction]);
  function release(cancel = false) {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    endInteraction();
    const next = cancel ? start.current : Math.round(positionRef.current);
    move(next);
    if (!cancel && !disabled) onChange(next);
  }
  return (
    <div
      className="brief-authority-slider"
      data-dragging={dragging}
      data-disabled={disabled}
      style={
        {
          "--authority-position": `${((position - 1) / 9) * 100}%`,
        } as CSSProperties
      }
    >
      <div className="brief-authority-slider__visual" aria-hidden="true">
        <span className="brief-authority-slider__track" />
        <span className="brief-authority-slider__fill" />
        <span className="brief-authority-slider__thumb" />
        <span className="brief-authority-slider__value">
          {Math.round(position)} / 10
        </span>
        <div className="brief-authority-slider__stops">
          {Array.from({ length: 10 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      </div>
      <input
        type="range"
        min={1}
        max={10}
        step="any"
        value={position}
        disabled={disabled}
        aria-label="Default authority level"
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)} of 10`}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0 || !beginInteraction()) return;
          start.current = value;
          active.current = true;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onChange={(e) => {
          const next = clamp(Number(e.target.value));
          move(next);
          if (!active.current) onChange(Math.round(next));
        }}
        onPointerUp={() => release()}
        onPointerCancel={() => release(true)}
        onLostPointerCapture={() => release(true)}
        onKeyDown={(e) => {
          if (disabled || active.current) return;
          const offsets: Record<string, number> = {
            ArrowLeft: -1,
            ArrowDown: -1,
            ArrowRight: 1,
            ArrowUp: 1,
            PageDown: -1,
            PageUp: 1,
          };
          if (e.key !== "Home" && e.key !== "End" && !(e.key in offsets))
            return;
          e.preventDefault();
          const next = clamp(
            e.key === "Home"
              ? 1
              : e.key === "End"
                ? 10
                : Math.round(positionRef.current) + offsets[e.key]!,
          );
          move(next);
          onChange(next);
        }}
      />
      <div className="brief-authority-slider__scale" aria-hidden="true">
        <span>1 · Cautious</span>
        <span>5 · Balanced</span>
        <span>10 · Trusted</span>
      </div>
    </div>
  );
}
