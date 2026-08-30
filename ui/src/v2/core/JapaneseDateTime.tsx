import React, { useEffect, useMemo, useState } from "react";

const TIME_ZONE = "Asia/Tokyo";

export function JapaneseDateTime() {
  const [now, setNow] = useState(() => new Date());
  const formatters = useMemo(() => ({
    date: new Intl.DateTimeFormat("ja-JP", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }),
    time: new Intl.DateTimeFormat("ja-JP", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
  }), []);

  useEffect(() => {
    const tick = () => setNow(new Date());
    const timeout = window.setTimeout(() => {
      tick();
      const interval = window.setInterval(tick, 1000);
      intervalRef = interval;
    }, 1000 - (Date.now() % 1000));
    let intervalRef: number | undefined;
    return () => {
      window.clearTimeout(timeout);
      if (intervalRef !== undefined) window.clearInterval(intervalRef);
    };
  }, []);

  return (
    <time className="rs-jp-clock" dateTime={now.toISOString()} aria-label={`${formatters.date.format(now)} ${formatters.time.format(now)}`}>
      <span>{formatters.date.format(now)}</span>
      <b>{formatters.time.format(now)}</b>
    </time>
  );
}
