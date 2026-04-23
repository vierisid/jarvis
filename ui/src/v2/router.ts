import { useEffect, useState } from "react";

export type V2Route = "home" | "primitives";

export function getV2Route(): V2Route {
  if (typeof window === "undefined") return "home";
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "_primitives") return "primitives";
  return "home";
}

export function useV2Route(): V2Route {
  const [route, setRoute] = useState<V2Route>(getV2Route);

  useEffect(() => {
    const onHashChange = () => setRoute(getV2Route());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

export function navigateV2(route: V2Route): void {
  const hash = route === "home" ? "#/" : `#/${route === "primitives" ? "_primitives" : route}`;
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}
